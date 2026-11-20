'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

function bridgeDir() {
  return process.env.JAVA_NAV_BRIDGE_DIR || path.join(os.tmpdir(), 'trae-java-bridge');
}

function normalize(p) {
  try { return path.resolve(p).toLowerCase().replace(/\\/g, '/'); } catch (_) { return String(p || '').toLowerCase(); }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function readBridges() {
  const dir = bridgeDir();
  let files;
  try { files = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch (_) { return []; }
  const out = [];
  for (const name of files) {
    const file = path.join(dir, name);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      // 窗口崩溃/未正常退出会留下失效文件：顺手清理
      if (!data.port || !data.token || !pidAlive(data.pid)) {
        try { fs.unlinkSync(file); } catch (_) { /* ignore */ }
        continue;
      }
      out.push({ ...data, file, startedAt: Date.parse(data.startedAt || 0) || 0 });
    } catch (_) { /* ignore */ }
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  // 目录里没有存活窗口时顺手删除空目录，避免卸载后残留
  if (!out.length) {
    try {
      if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
    } catch (_) { /* ignore */ }
  }
  return out;
}

function findBridge(workspaceRoot) {
  const root = normalize(workspaceRoot || process.cwd());
  const candidates = [];
  for (const data of readBridges()) {
    const folders = (data.workspaceFolders || []).map(normalize);
    // 没有打开文件夹时仍可作为候选，优先级低于精确匹配
    if (!folders.length) { candidates.push({ ...data, match: 0 }); continue; }
    const matches = folders.some((f) => root === f || root.startsWith(f + '/') || f.startsWith(root + '/'));
    if (!matches) continue;
    candidates.push({ ...data, match: 1 });
  }
  candidates.sort((a, b) => b.match - a.match || b.startedAt - a.startedAt);
  return candidates[0] || null;
}

// 桥接上报的 IDE 工作区，用于 MCP 侧自动定位 Java 工程（不依赖启动 cwd）
function listBridgeWorkspaces() {
  const out = [];
  for (const data of readBridges()) {
    for (const f of data.workspaceFolders || []) {
      if (f && !out.includes(f)) out.push(f);
    }
  }
  return out;
}

// 当前 IDE 里 redhat.java 扩展的真实位置，用于兜底 JDT LS 精确定位
function latestRedhatJavaPath() {
  for (const data of readBridges()) {
    if (data.redhatJavaPath) return data.redhatJavaPath;
  }
  return null;
}

function requestTimeout() {
  const n = Number(process.env.JAVA_NAV_BRIDGE_TIMEOUT);
  return Number.isFinite(n) && n > 0 ? n : 20000;
}

function envNumber(name, fallback, min) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

// 项目模型刷新可能持续几十秒，默认 65s，可用 JAVA_NAV_REFRESH_TIMEOUT 调整
function refreshTimeout() {
  return envNumber('JAVA_NAV_REFRESH_TIMEOUT', 65000, 5000);
}

function request(bridge, apiPath, params, timeoutMs) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) qs.set(k, String(v));
  }
  const query = qs.toString();
  const fullPath = apiPath + (query ? '?' + query : '');
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port: bridge.port,
      path: fullPath,
      headers: { authorization: 'Bearer ' + bridge.token },
      timeout: Number(timeoutMs) > 0 ? Number(timeoutMs) : requestTimeout(),
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error('bridge HTTP ' + res.statusCode + ': ' + body));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('bridge timeout')); });
    req.on('error', reject);
  });
}

function health(bridge) {
  return request(bridge, '/health', {});
}

// 项目模型刷新可能持续几十秒（完整重载/增量构建），必须使用比普通查询更长的超时
function refreshProject(bridge, mode, timeoutMs) {
  const wait = Number(timeoutMs) > 0 ? Number(timeoutMs) : 15000;
  return request(
    bridge,
    '/refresh',
    { mode: mode || 'auto', timeout: wait },
    Math.max(refreshTimeout(), wait + 10000),
  );
}

async function callBridge(bridge, tool, args) {
  switch (tool) {
    case 'workspaceSymbols':
      return request(bridge, '/symbols', { query: args.query || '', limit: args.limit || 50 });
    case 'definition':
      return request(bridge, '/definition', { file: args.file, line: args.line, column: args.column });
    case 'references':
      return request(bridge, '/references', {
        file: args.file,
        line: args.line,
        column: args.column,
        limit: args.limit,
      });
    case 'documentSymbols':
      return request(bridge, '/documentSymbols', {
        file: args.file,
        name: args.name,
        kind: args.kind,
        limit: args.limit,
      });
    case 'hover':
      return request(bridge, '/hover', { file: args.file, line: args.line, column: args.column });
    case 'fileDiagnostics':
      return request(bridge, '/diagnostics', { file: args.file, severity: args.severity || 'all' });
    case 'projectDiagnostics':
      return request(bridge, '/diagnostics', { severity: args.severity || 'error' });
    default:
      throw new Error('bridge 不支持工具: ' + tool);
  }
}

module.exports = { findBridge, callBridge, health, refreshProject, listBridgeWorkspaces, latestRedhatJavaPath };