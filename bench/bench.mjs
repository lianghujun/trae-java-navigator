#!/usr/bin/env node
'use strict';

// MCP / 桥接 / ripgrep 的对照基准。
// 用法：
//   node bench/generate-fixtures.mjs --scales 10,100,1000
//   node bench/bench.mjs --modes rg,mcp --repeats 10
//   node bench/bench.mjs --modes rg,bridge --bridge-workspace <你的Java工程根目录>
// 说明：MCP 场景会为每个 fixture 启动独立 JDT LS（冷启动），首次就绪耗时单独记录。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const { findBridge } = require('../server/bridge-client.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP = path.join(HERE, '..', 'server', 'mcp-server.js');

const { values } = parseArgs({
  options: {
    fixtures: { type: 'string', default: path.join(os.tmpdir(), 'trae-java-bench') },
    repeats: { type: 'string', default: '10' },
    modes: { type: 'string', default: 'rg,mcp' },
    scales: { type: 'string', default: '' },
    rg: { type: 'string', default: 'rg' },
    'bridge-workspace': { type: 'string', default: '' },
    'mcp-timeout': { type: 'string', default: '300000' },
    out: { type: 'string', default: '' },
  },
});

const FIXTURES = path.resolve(values.fixtures);
const REPEATS = Math.max(1, Number(values.repeats) || 10);
const MODES = new Set(String(values.modes).split(',').map((s) => s.trim()));
const SCALE_FILTER = String(values.scales)
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n));
const RG = values.rg;
const MCP_TIMEOUT = Math.max(30000, Number(values['mcp-timeout']) || 300000);
const OUT = path.resolve(values.out || path.join(FIXTURES, 'out'));
const BRIDGE_WORKSPACE = values['bridge-workspace'] ? path.resolve(values['bridge-workspace']) : '';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function percentile(arr, p) {
  const a = arr.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const idx = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1));
  return a[idx];
}

function fmt(n, digits = 1) {
  return Number.isFinite(n) ? n.toFixed(digits) : '-';
}

function ms(n) {
  return fmt(n, 1);
}

// ---------------------------------------------------------------------------
// ripgrep
// ---------------------------------------------------------------------------
function rgRun(args) {
  const t = process.hrtime.bigint();
  const r = spawnSync(RG, args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, windowsHide: true });
  const elapsed = Number(process.hrtime.bigint() - t) / 1e6;
  const out = r.stdout || '';
  return {
    ms: elapsed,
    bytes: Buffer.byteLength(out),
    out,
    hits: out.split(/\r?\n/).filter(Boolean).length,
    error: r.error ? r.error.message : null,
  };
}

function rgScenarios(f) {
  if (f.kind === 'file') {
    const file = path.join(f.root, f.bigFile);
    return [{
      name: 'rg:lines',
      fn: () => rgRun(['-n', '--no-heading', '--no-messages', 'needleMethod', file]),
    }];
  }
  const dir = f.root;
  const base = ['--no-messages', '--glob', '*.java', 'BenchTarget', dir];
  const scenarios = [
    { name: 'rg:list', fn: () => rgRun(['-l', ...base]) },
    { name: 'rg:lines', fn: () => rgRun(['-n', '--no-heading', ...base]) },
    {
      name: 'rg:verify',
      fn: () => {
        const t = process.hrtime.bigint();
        const r = spawnSync(RG, ['-l', ...base], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, windowsHide: true });
        const files = (r.stdout || '').split(/\r?\n/).filter(Boolean);
        let bytes = Buffer.byteLength(r.stdout || '');
        for (const p of files) {
          try { bytes += fs.readFileSync(p).length; } catch (_) { /* ignore */ }
        }
        return {
          ms: Number(process.hrtime.bigint() - t) / 1e6,
          bytes,
          hits: files.length,
          error: r.error ? r.error.message : null,
        };
      },
    },
  ];
  return scenarios;
}

// ---------------------------------------------------------------------------
// MCP stdio 客户端
// ---------------------------------------------------------------------------
class McpClient {
  constructor(env) {
    this.child = spawn(process.execPath, [MCP], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.child.stdout.on('data', (d) => this.onData(d));
    this.child.stderr.on('data', (d) => { this.stderr += d.toString(); });
    this.ready = this.init();
  }

  onData(d) {
    this.buf += d.toString();
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id);
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message || 'rpc error'));
        else entry.resolve(msg.result);
      }
    }
  }

  request(method, params, timeoutMs = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async init() {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'java-nav-bench', version: '0.0.1' },
    }, 30000);
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  async callTool(name, args, timeoutMs = 120000) {
    await this.ready;
    const res = await this.request('tools/call', { name, arguments: args || {} }, timeoutMs);
    const text = res && res.content && res.content[0] ? res.content[0].text : '';
    if (res && res.isError) throw new Error(text || 'tool error');
    try { return JSON.parse(text); } catch (_) { return { raw: text }; }
  }

  close() {
    try { this.child.stdin.end(); } catch (_) { /* ignore */ }
    try { this.child.kill(); } catch (_) { /* ignore */ }
  }
}

async function waitReady(mcp, query, timeoutMs) {
  await mcp.callTool('java_status', { warmup: true }, 60000).catch(() => { });
  const deadline = Date.now() + timeoutMs;
  let status = null;
  while (Date.now() < deadline) {
    try {
      status = await mcp.callTool('java_status', {}, 30000);
      const probe = await mcp.callTool('java_search', { query, limit: 5 }, 60000);
      if (probe && Array.isArray(probe.items) && probe.items.length) return { ready: true, status };
    } catch (_) { /* 索引尚未就绪，继续等 */ }
    await sleep(1500);
  }
  return { ready: false, status };
}

function mcpCall(mcp, name, args) {
  const t = process.hrtime.bigint();
  return mcp.callTool(name, args, 120000)
    .then((value) => ({
      ms: Number(process.hrtime.bigint() - t) / 1e6,
      bytes: Buffer.byteLength(JSON.stringify(value)),
      value,
    }))
    .catch((e) => ({
      ms: Number(process.hrtime.bigint() - t) / 1e6,
      bytes: 0,
      error: e.message,
    }));
}

function mcpScenarios(f) {
  if (f.kind === 'file') {
    return [
      ['mcp:fileSymbol', () => mcpCall(mcpClientFor(f), 'java_search', { file: f.bigFile, name: 'needleMethod', limit: 10 })],
    ];
  }
  if (f.kind === 'diag') {
    return [
      ['mcp:search', () => mcpCall(mcpClientFor(f), 'java_search', { query: f.query, limit: 50 })],
      ['mcp:diagnostics', () => mcpCall(mcpClientFor(f), 'java_diagnostics', { severity: 'error', limit: Math.max(100, f.expectedErrors * 2) })],
    ];
  }
  return [
    ['mcp:search', () => mcpCall(mcpClientFor(f), 'java_search', { query: f.query, limit: 50 })],
    ['mcp:fileSymbol', () => mcpCall(mcpClientFor(f), 'java_search', { file: f.callerFile, name: 'use', limit: 20 })],
    ['mcp:definition', () => mcpCall(mcpClientFor(f), 'java_navigate', { action: 'definition', file: f.callerFile, line: f.callerLine, column: f.callerColumn })],
    ['mcp:references', () => mcpCall(mcpClientFor(f), 'java_navigate', { action: 'references', file: f.targetFile, line: f.targetLine, column: f.targetColumn, limit: 100 })],
  ];
}

// 每个 fixture 复用一个 MCP/JDT LS 进程（场景内热态），进程冷启动单独记录
// 每次 bench 运行使用全新的 JDT 工作区缓存，避免上次失败的 Maven 导入状态残留
const RUN_CACHE = path.join(FIXTURES, 'cache', String(Date.now()));
const mcpClients = new Map();
function mcpClientFor(f) {
  if (!mcpClients.has(f.root)) {
    mcpClients.set(f.root, new McpClient({
      JAVA_NAV_WORKSPACE: f.root,
      // 强制独立 JDT LS，避免误连到不相关的 IDE 窗口
      JAVA_NAV_BRIDGE_DIR: path.join(f.root, '.no-bridge'),
      JAVA_NAV_LSP_INIT_TIMEOUT: String(Math.min(MCP_TIMEOUT, 120000)),
      TRAE_JAVA_NAV_CACHE: RUN_CACHE,
    }));
  }
  return mcpClients.get(f.root);
}

function describe(scenario, r) {
  if (!r) return '-';
  if (r.error) return 'error: ' + r.error.slice(0, 100);
  const v = r.value || {};
  if (scenario.startsWith('mcp:search') || scenario === 'mcp:fileSymbol') return `items=${(v.items || []).length}`;
  if (scenario === 'mcp:definition') return `items=${(v.items || []).length}`;
  if (scenario === 'mcp:references') return `refs=${v.count} returned=${v.returned} truncated=${v.truncated === true}`;
  if (scenario === 'mcp:diagnostics') return `errors=${v.total}`;
  if (scenario === 'bridge:search' || scenario === 'bridge:definition') return `items=${(v.items || []).length}`;
  if (scenario === 'bridge:references') return `refs=${v.count} returned=${v.returned == null ? (v.items || []).length : v.returned} truncated=${v.truncated === true}`;
  if (scenario === 'bridge:diagnostics') return `errors=${v.total}`;
  if (scenario.startsWith('rg:')) return `hits=${r.hits}`;
  return '-';
}

function expectedFor(f, scenario) {
  if (scenario === 'mcp:search' || scenario === 'mcp:fileSymbol') return f.expectedSymbols;
  if (scenario === 'mcp:definition') return 1;
  if (scenario === 'mcp:references') return f.expectedRefs;
  if (scenario === 'mcp:diagnostics') return f.expectedErrors;
  return null;
}

function actualFor(scenario, r) {
  const v = (r && r.value) || {};
  if (scenario === 'mcp:search' || scenario === 'mcp:fileSymbol' || scenario === 'mcp:definition') return (v.items || []).length;
  if (scenario === 'mcp:references') return v.count;
  if (scenario === 'mcp:diagnostics') return v.total;
  return null;
}

async function measure(name, fn, repeats) {
  const samples = [];
  const once = () => Promise.resolve().then(fn);
  await once().catch(() => { }); // 丢弃预热
  for (let i = 0; i < repeats; i++) {
    samples.push(await once().catch((e) => ({ ms: NaN, bytes: 0, error: e.message })));
  }
  const last = samples[samples.length - 1];
  return {
    p50: percentile(samples.map((s) => s.ms), 50),
    p95: percentile(samples.map((s) => s.ms), 95),
    bytes: percentile(samples.map((s) => s.bytes || 0), 50),
    samples: samples.length,
    last,
  };
}

async function runFixture(f, opts) {
  const rows = [];
  if (MODES.has('rg')) {
    for (const s of rgScenarios(f)) {
      const m = await measure(s.name, s.fn, REPEATS);
      const hitLines = m.last && m.last.hits != null ? m.last.hits : null;
      const precision = f.kind === 'repo' && hitLines
        ? `${fmt((f.trueCodeLines / hitLines) * 100, 1)}%`
        : '';
      rows.push({
        fixture: f.id, kind: f.kind, scale: f.scale, scenario: s.name,
        p50: m.p50, p95: m.p95, bytes: m.bytes, samples: m.samples,
        info: `${describe(s.name, m.last)}${precision ? ` precision=${precision}` : ''}`,
      });
    }
  }
  if (MODES.has('mcp')) {
    const client = mcpClientFor(f);
    try {
      const t0 = Date.now();
      const ready = await waitReady(client, f.query, MCP_TIMEOUT);
      const initMs = Date.now() - t0;
      if (!ready.ready) {
        console.log(`  ! ${f.id}: JDT LS 在 ${MCP_TIMEOUT}ms 内未就绪，跳过 MCP 场景`);
        return rows;
      }
      console.log(`  ${f.id}: JDT LS 就绪 ${ms(initMs)}ms`);
      for (const [name, fn] of mcpScenarios(f)) {
        const m = await measure(name, fn, REPEATS);
        const actual = actualFor(name, m.last);
        const expected = expectedFor(f, name);
        const ok = expected == null ? null : actual === expected;
        rows.push({
          fixture: f.id, kind: f.kind, scale: f.scale, scenario: name,
          p50: m.p50, p95: m.p95, bytes: m.bytes, samples: m.samples,
          info: `${describe(name, m.last)}${ok === false ? ` expected=${expected}` : ''}`,
          ok,
          initMs,
        });
      }
    } finally {
      client.close();
      mcpClients.delete(f.root);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 桥接（真实 IDE 工程）
// ---------------------------------------------------------------------------
function httpGet(bridge, apiPath) {
  return new Promise((resolve, reject) => {
    const t = process.hrtime.bigint();
    const req = http.get({
      host: '127.0.0.1',
      port: bridge.port,
      path: apiPath,
      headers: { authorization: 'Bearer ' + bridge.token },
      timeout: 120000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        const elapsed = Number(process.hrtime.bigint() - t) / 1e6;
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        let value;
        try { value = JSON.parse(body); } catch (_) { value = { raw: body }; }
        resolve({ ms: elapsed, bytes: Buffer.byteLength(body), value });
      });
    });
    req.on('timeout', () => req.destroy(new Error('bridge timeout')));
    req.on('error', reject);
  });
}

function walkJavaFiles(dir, limit) {
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < limit) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (out.length >= limit) break;
      if (e.name === '.git' || e.name === 'node_modules' || e.name === 'target' || e.name === 'build') continue;
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/\.java$/i.test(e.name)) out.push(p);
    }
  }
  return out;
}

async function runBridge(workspace) {
  const bridge = findBridge(workspace);
  if (!bridge) {
    console.log(`! 未找到 ${workspace} 的桥接实例：请先在该工作区打开 IDE（扩展 0.1.18+）`);
    return [];
  }
  const rows = [];
  const files = walkJavaFiles(workspace, 80);
  let picked = null;
  for (const file of files) {
    const name = path.basename(file, '.java');
    try {
      const r = await httpGet(bridge, `/symbols?query=${encodeURIComponent(name)}&limit=3`);
      const item = (r.value.items || []).find((i) => i.file && i.line);
      if (item) { picked = { name, item }; break; }
    } catch (_) { /* 继续尝试 */ }
  }
  if (!picked) {
    console.log('! 未能在该工作区找到可用的类符号，跳过桥接场景');
    return [];
  }
  const pos = `file=${encodeURIComponent(picked.item.file)}&line=${picked.item.line}&column=${picked.item.column}`;
  const scenarios = [
    ['bridge:search', `/symbols?query=${encodeURIComponent(picked.name)}&limit=50`],
    ['bridge:definition', `/definition?${pos}`],
    ['bridge:references', `/references?${pos}&limit=100`],
    ['bridge:diagnostics', '/diagnostics?severity=error'],
  ];
  console.log(`  桥接场景符号：${picked.name} → ${picked.item.file}:${picked.item.line}`);
  for (const [name, api] of scenarios) {
    const m = await measure(name, () => httpGet(bridge, api), REPEATS);
    rows.push({
      fixture: path.basename(workspace), kind: 'real', scale: null, scenario: name,
      p50: m.p50, p95: m.p95, bytes: m.bytes, samples: m.samples,
      info: describe(name, m.last),
    });
  }
  // 同符号的 rg 基线
  const base = ['--no-messages', '--glob', '*.java', picked.name, workspace];
  for (const [name, args] of [['rg:list', ['-l', ...base]], ['rg:lines', ['-n', '--no-heading', ...base]]]) {
    const m = await measure(name, () => Promise.resolve(rgRun(args)), REPEATS);
    rows.push({
      fixture: path.basename(workspace), kind: 'real', scale: null, scenario: name,
      p50: m.p50, p95: m.p95, bytes: m.bytes, samples: m.samples,
      info: `hits=${m.last && m.last.hits}`,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
function renderMarkdown(rows) {
  const lines = [];
  lines.push('| fixture | kind | scale | scenario | p50 ms | p95 ms | bytes(p50) | samples | info |');
  lines.push('|---|---|---|---|---:|---:|---:|---:|---|');
  for (const r of rows) {
    lines.push(`| ${r.fixture} | ${r.kind} | ${r.scale == null ? '-' : r.scale} | ${r.scenario} | ${ms(r.p50)} | ${ms(r.p95)} | ${Math.round(r.bytes || 0)} | ${r.samples} | ${r.info || '-'} |`);
  }
  lines.push('');
  lines.push('### 相对 rg:lines 的耗时比（越大越快）');
  lines.push('| fixture | scenario | p50 加速 |');
  lines.push('|---|---|---:|');
  const byFixture = new Map();
  for (const r of rows) {
    if (!byFixture.has(r.fixture)) byFixture.set(r.fixture, {});
    byFixture.get(r.fixture)[r.scenario] = r;
  }
  for (const [fixture, m] of byFixture) {
    const base = m['rg:lines'];
    if (!base || !Number.isFinite(base.p50)) continue;
    for (const [scenario, r] of Object.entries(m)) {
      if (!scenario.startsWith('mcp:') && !scenario.startsWith('bridge:')) continue;
      if (!Number.isFinite(r.p50) || r.p50 <= 0) continue;
      lines.push(`| ${fixture} | ${scenario} | ${fmt(base.p50 / r.p50, 2)}x |`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const manifestPath = path.join(FIXTURES, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`缺少 ${manifestPath}，请先运行：node bench/generate-fixtures.mjs --out ${FIXTURES}`);
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    .filter((f) => !SCALE_FILTER.length || SCALE_FILTER.includes(Number(f.scale)));
  const rows = [];
  for (const f of manifest) {
    console.log(`\n# ${f.id} (files=${f.files})`);
    rows.push(...(await runFixture(f, { repeats: REPEATS })));
  }
  if (MODES.has('bridge')) {
    if (!BRIDGE_WORKSPACE) {
      console.log('\n! --modes 含 bridge 时需要 --bridge-workspace <已打开的工作区>');
    } else {
      console.log(`\n# bridge ${BRIDGE_WORKSPACE}`);
      rows.push(...(await runBridge(BRIDGE_WORKSPACE)));
    }
  }
  if (!rows.length) {
    console.error('没有采集到数据，检查模式与工作区参数。');
    process.exit(1);
  }
  const md = renderMarkdown(rows);
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(rows, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT, 'report.md'), md + '\n', 'utf8');
  console.log('\n' + md);
  console.log(`\n已写入 ${path.join(OUT, 'report.md')} 与 result.json`);
}

process.on('exit', () => {
  for (const c of mcpClients.values()) c.close();
});

main().catch((e) => {
  console.error('bench failed: ' + e.message);
  process.exit(1);
});