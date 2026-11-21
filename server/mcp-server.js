'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { pathToFileURL, fileURLToPath } = require('url');

const { LspClient } = require('./lsp-client');
const { findServerDir, buildArgs, findJava, findLombokJar } = require('./jdtls');
const bridgeClient = require('./bridge-client');
const { cleanupPendingVersions } = require('./pending-cleanup');
const { loadJavaSettings, detectProjectJavaVersion, javaSettingsForSection } = require('./settings-reader');

// ---------------------------------------------------------------------------
// MCP stdio 传输：一行一个 JSON-RPC 消息；日志只能写 stderr
// ---------------------------------------------------------------------------
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function log(msg) {
  process.stderr.write('[java-navigator] ' + msg + '\n');
}

// 版本号只在 plugin.json 维护一处，避免 serverInfo 与实际插件版本漂移
function pluginVersion() {
  try {
    const file = path.join(__dirname, '..', '.trae-plugin', 'plugin.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).version || '0.1.4';
  } catch (_) {
    return '0.1.4';
  }
}

const SERVER_VERSION = pluginVersion();

function envNumber(name, fallback, min) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

// 可用环境变量调整：JAVA_NAV_REFRESH_WAIT / JAVA_NAV_AUTO_CONFIG_MIN_FILES / JAVA_NAV_QUIET_MS
const REFRESH_WAIT_MS = envNumber('JAVA_NAV_REFRESH_WAIT', 20000, 1000);
const AUTO_CONFIG_MIN_FILES = envNumber('JAVA_NAV_AUTO_CONFIG_MIN_FILES', 50, 1);
const DIAG_QUIET_MS = envNumber('JAVA_NAV_QUIET_MS', 800, 100);

// ---------------------------------------------------------------------------
// 工作区与 JDT LS
// ---------------------------------------------------------------------------
function hasJavaProject(dir) {
  const exists = (p) => { try { return fs.existsSync(p); } catch (_) { return false; } };
  return exists(path.join(dir, 'pom.xml'))
    || exists(path.join(dir, 'build.gradle'))
    || exists(path.join(dir, 'build.gradle.kts'))
    || exists(path.join(dir, 'settings.gradle'))
    || exists(path.join(dir, 'src', 'main', 'java'));
}

// 直接在目录本身或下一级子目录中寻找 Java 工程（兼容“仓库根 + 后端子目录”布局）
function javaProjectUnder(dir) {
  if (hasJavaProject(dir)) return dir;
  const candidates = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const child = path.join(dir, name);
      try {
        if (fs.statSync(child).isDirectory() && hasJavaProject(child)) candidates.push(child);
      } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }
  candidates.sort();
  return candidates[0] || null;
}

function looksLikePluginDir(dir) {
  try {
    if (fs.existsSync(path.join(dir, '.trae-plugin'))) return true;
    return /[\\/]plugins[\\/]/.test(dir);
  } catch (_) {
    return false;
  }
}

function resolveWorkspaceRoot() {
  if (process.env.JAVA_NAV_WORKSPACE) {
    return path.resolve(process.env.JAVA_NAV_WORKSPACE);
  }

  // IDE 注入的工作区环境变量：不依赖 MCP 进程的启动目录
  const fromEnv = [
    process.env.TRAE_WORKSPACE_FOLDER,
    process.env.WORKSPACE_FOLDER,
    process.env.VSCODE_WORKSPACE_FOLDER,
    process.env.INIT_CWD,
    process.env.PWD,
  ].filter(Boolean).map((p) => path.resolve(p));
  for (const dir of fromEnv) {
    const found = javaProjectUnder(dir);
    if (found) return found;
  }

  // 桥接扩展上报的 IDE 工作区
  for (const dir of bridgeClient.listBridgeWorkspaces()) {
    const found = javaProjectUnder(path.resolve(dir));
    if (found) return found;
  }

  const cwd = path.resolve(process.cwd());
  const found = javaProjectUnder(cwd);
  if (found) return found;

  // Trae 以插件版本目录作为 MCP 的 cwd，绝不能把它当成工作区
  const fallback = fromEnv.find((p) => fs.existsSync(p) && !looksLikePluginDir(p));
  if (fallback) return fallback;
  return looksLikePluginDir(cwd) ? null : cwd;
}

let WORKSPACE_ROOT = null;
let WORKSPACE_URI = null;
let JAVA_SETTINGS = { runtimes: [], mavenEnabled: true, sourceLevel: null };
let PROJECT_JAVA_VERSION = null;

function refreshWorkspace(root) {
  WORKSPACE_ROOT = root;
  WORKSPACE_URI = pathToFileURL(root).href;
  JAVA_SETTINGS = loadJavaSettings(root);
  PROJECT_JAVA_VERSION = detectProjectJavaVersion(root);
}

// 延迟解析：MCP 往往比 IDE 扩展更早启动，首次工具调用时再读桥接/环境变量
function ensureWorkspace() {
  if (WORKSPACE_ROOT && hasJavaProject(WORKSPACE_ROOT)) return WORKSPACE_ROOT;
  const root = resolveWorkspaceRoot();
  if (!root) {
    throw new Error('未找到 Java 工程：请设置 JAVA_NAV_WORKSPACE，或在 IDE 中打开工程（桥接会自动上报工作区）');
  }
  if (root !== WORKSPACE_ROOT) refreshWorkspace(root);
  return WORKSPACE_ROOT;
}

function dataDirFor(root) {
  const base = process.env.TRAE_JAVA_NAV_CACHE || os.tmpdir();
  const hash = crypto.createHash('sha1').update(root).digest('hex').slice(0, 12);
  const dir = path.join(base, 'trae-java-navigator', 'jdt-ws-' + hash);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let client = null;
let initPromise = null;
let indexStatus = '未启动';
let serviceReady = false;
let diagnosticsByUri = new Map();
let lastBridgeError = null;
const openedFiles = new Set();
const diagnosticsWaiters = new Set();

function notifyDiagnosticsActivity() {
  for (const fn of [...diagnosticsWaiters]) fn();
}

// 项目重载是异步的：等待诊断变化后的静默窗口，作为刷新完成的近似信号
function waitForDiagnosticsQuiet(timeoutMs) {
  return new Promise((resolve) => {
    let quietTimer = null;
    let finished = false;
    const onActivity = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(true), DIAG_QUIET_MS);
    };
    diagnosticsWaiters.add(onActivity);
    const hard = setTimeout(() => finish(false), Math.max(1000, timeoutMs));
    function finish(ok) {
      if (finished) return;
      finished = true;
      clearTimeout(hard);
      if (quietTimer) clearTimeout(quietTimer);
      diagnosticsWaiters.delete(onActivity);
      resolve(ok);
    }
  });
}

function lspInitTimeout() {
  const n = Number(process.env.JAVA_NAV_LSP_INIT_TIMEOUT);
  return Number.isFinite(n) && n > 0 ? n : 60000;
}

function javaCommand() {
  if (process.env.JAVA_HOME) {
    const exe = process.platform === 'win32' ? 'java.exe' : 'java';
    const p = path.join(process.env.JAVA_HOME, 'bin', exe);
    if (fs.existsSync(p)) return p;
  }
  return 'java';
}

async function getClient() {
  if (initPromise) return initPromise;
  // 初始化失败/超时后清空 promise，下一次调用可重试，不会永久挂住
  initPromise = startClient().catch((e) => {
    initPromise = null;
    throw e;
  });
  return initPromise;
}

async function startClient() {
    const root = ensureWorkspace();
    const serverDir = findServerDir(bridgeClient.latestRedhatJavaPath());
    if (!serverDir) {
      throw new Error('找不到 redhat.java 的 JDT LS（可用 JDTLS_HOME 指定 server 目录）');
    }
    log('JDT LS server: ' + serverDir);
    const lsp = new LspClient({
      command: findJava(serverDir),
      args: buildArgs(serverDir, dataDirFor(root), { metadataAtProjectRoot: JAVA_SETTINGS.metadataAtProjectRoot === true }),
      cwd: root,
    });

    lsp.onNotification('textDocument/publishDiagnostics', (params) => {
      if (!params || !params.uri) return;
      diagnosticsByUri.set(params.uri, {
        version: params.version,
        diagnostics: params.diagnostics || [],
      });
      notifyDiagnosticsActivity();
    });
    lsp.onNotification('language/status', (params) => {
      const type = params && params.type ? String(params.type) : '';
      const message = params && params.message ? String(params.message) : '';
      if (type) indexStatus = message ? `${type}: ${message}` : type;
      if (type === 'ServiceReady') { indexStatus = 'ServiceReady'; serviceReady = true; }
      if (type === 'Error') indexStatus = 'Error: ' + message;
    });
    lsp.onNotification('$/progress', () => { /* 进度事件不落状态，避免噪声 */ });
    lsp.setConfigProvider((section) => javaSettingsForSection(JAVA_SETTINGS, section));

    lsp.start();
    const rootUri = WORKSPACE_URI;
    const rootName = path.basename(root) || 'workspace';
    try {
      await lsp.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'trae-java-navigator', version: SERVER_VERSION },
      rootPath: root,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: rootName }],
      capabilities: {
        workspace: {
          symbol: { resolveSupport: { properties: ['location', 'range'] } },
          workspaceFolders: true,
          configuration: true,
          diagnostics: { refreshSupport: true },
        },
        textDocument: {
          synchronization: { dynamicRegistration: true },
          definition: { linkSupport: true },
          references: {},
          hover: { contentFormat: ['markdown', 'plaintext'] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: { relatedInformation: true },
          diagnostic: {},
        },
      },
      initializationOptions: {
        settings: {
          java: {
            import: {
              maven: { enabled: JAVA_SETTINGS.mavenEnabled },
              // 兜底 JDT LS 默认不向工程根写 .project/.classpath/.settings 等 Eclipse 元数据
              generatesMetadataFilesAtProjectRoot: JAVA_SETTINGS.metadataAtProjectRoot === true,
            },
            configuration: {
              updateBuildConfiguration: 'automatic',
              runtimes: JAVA_SETTINGS.runtimes,
            },
            project: JAVA_SETTINGS.sourceLevel ? { source: { level: JAVA_SETTINGS.sourceLevel } } : {},
            signatureHelp: { enabled: true },
            contentProvider: { preferred: 'fernflower' },
          },
        },
      },
      trace: 'off',
      }, lspInitTimeout());
    } catch (e) {
      try { lsp.stop(); } catch (_) { /* ignore */ }
      indexStatus = 'InitError: ' + e.message;
      throw new Error('JDT LS 初始化失败或超时（' + e.message + '）。可先调用 java_index_status，或调大 JAVA_NAV_LSP_INIT_TIMEOUT');
    }
    lsp.notify('initialized', {});
    indexStatus = 'Initialized（后台建索引中）';
    client = lsp;
    return lsp;
}

// ---------------------------------------------------------------------------
// 文件 / 位置工具
// ---------------------------------------------------------------------------
// 相对路径兼容两种常见写法：相对工作区根，或“工程目录名/相对路径”（工作区本身就是工程根时）
function fileCandidates(file) {
  if (path.isAbsolute(file)) return [file];
  const root = ensureWorkspace();
  const out = [path.resolve(root, file)];
  const base = path.basename(root);
  const normalized = String(file).replace(/\\/g, '/');
  if (normalized === base || normalized.startsWith(base + '/')) {
    const rest = normalized.slice(base.length).replace(/^\/+/, '');
    out.push(path.resolve(root, rest || '.'));
  }
  out.push(path.resolve(path.dirname(root), file));
  return [...new Set(out)];
}

function absoluteFile(file) {
  if (!file) throw new Error('缺少 file 参数');
  const candidates = fileCandidates(file);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('文件不存在: ' + candidates[0]
    + (candidates[1] && candidates[1] !== candidates[0] ? '（也未找到 ' + candidates[1] + '）' : '')
    + '。文件可能已被移动或删除，可改用 java_search 按符号名定位新位置。');
}

function toUri(file) {
  return pathToFileURL(absoluteFile(file)).href;
}

function fromUri(uri) {
  try { return fileURLToPath(uri); } catch (_) { return uri; }
}

function toPosition(line, column) {
  const ln = Number(line);
  const col = Number(column);
  if (!Number.isFinite(ln) || ln < 1) throw new Error('line 必须是从 1 开始的正整数');
  if (!Number.isFinite(col) || col < 1) throw new Error('column 必须是从 1 开始的正整数');
  return { line: ln - 1, character: col - 1 };
}

async function ensureOpen(file) {
  const lsp = await getClient();
  const uri = toUri(file);
  if (openedFiles.has(uri)) return uri;
  const text = fs.readFileSync(absoluteFile(file), 'utf8');
  lsp.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'java', version: 1, text },
  });
  openedFiles.add(uri);
  return uri;
}

function locationToJson(uri, range) {
  return {
    file: fromUri(uri),
    line: range && range.start ? range.start.line + 1 : null,
    column: range && range.start ? range.start.character + 1 : null,
    endLine: range && range.end ? range.end.line + 1 : null,
    endColumn: range && range.end ? range.end.character + 1 : null,
  };
}

function normalizeLocations(result) {
  if (!result) return [];
  const arr = Array.isArray(result) ? result : [result];
  const out = [];
  for (const item of arr) {
    if (!item) continue;
    if (item.uri && item.range) {
      out.push(locationToJson(item.uri, item.range));
    } else if (item.targetUri && item.targetRange) {
      out.push(locationToJson(item.targetUri, item.targetRange));
    } else if (item.location && item.location.uri) {
      out.push(locationToJson(item.location.uri, item.location.range));
    }
  }
  return out;
}

function symbolKindName(kind) {
  const names = {
    1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package', 5: 'Class', 6: 'Method',
    7: 'Property', 8: 'Field', 9: 'Constructor', 10: 'Enum', 11: 'Interface',
    12: 'Function', 13: 'Variable', 14: 'Constant', 15: 'String', 16: 'Number',
    17: 'Boolean', 18: 'Array', 19: 'Object', 20: 'Key', 21: 'Null', 22: 'EnumMember',
    23: 'Struct', 24: 'Event', 25: 'Operator', 26: 'TypeParameter',
  };
  return names[kind] || String(kind);
}

function hoverText(hover) {
  if (!hover || !hover.contents) return '';
  const c = hover.contents;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((x) => (typeof x === 'string' ? x : x && x.value ? x.value : '')).join('\n');
  }
  return c.value || '';
}

function severityName(sev) {
  return { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }[sev] || String(sev || 'unknown');
}

function filterDiagnostics(list, severity) {
  if (!severity || severity === 'all') return list;
  const wanted = String(severity).toLowerCase();
  return list.filter((d) => severityName(d.severity) === wanted);
}

// 与桥接端保持同一口径：total 只统计本次返回的条目，allTotal 才是全部级别
function languageOf(file) {
  const base = String(file || '');
  const i = base.lastIndexOf('.');
  return i > -1 ? base.slice(i + 1).toLowerCase() : 'unknown';
}

function summarizeDiagnostics(items) {
  const bySeverity = {};
  const bySource = {};
  const byLanguage = {};
  const byCode = {};
  for (const d of items) {
    const source = d.source || 'unknown';
    bySeverity[d.severity] = (bySeverity[d.severity] || 0) + 1;
    bySource[source] = (bySource[source] || 0) + 1;
    const lang = languageOf(d.file);
    byLanguage[lang] = (byLanguage[lang] || 0) + 1;
    const key = source + (d.code ? ':' + d.code : '');
    byCode[key] = (byCode[key] || 0) + 1;
  }
  return { bySeverity, bySource, byLanguage, byCode };
}

// 独立模式下同样给出工作区残留计数（只覆盖已推送诊断的文件）
function workspaceDiagnosticTotals() {
  const all = [];
  for (const [uri, entry] of diagnosticsByUri.entries()) {
    for (const d of entry.diagnostics || []) {
      all.push({
        file: fromUri(uri),
        severity: severityName(d.severity),
        source: d.source || '',
        code: d.code || '',
      });
    }
  }
  const summary = summarizeDiagnostics(all);
  return {
    total: all.length,
    bySeverity: summary.bySeverity,
    bySource: summary.bySource,
    byLanguage: summary.byLanguage,
  };
}

// ---------------------------------------------------------------------------
// IDE 桥接优先，独立 JDT LS 兜底
// ---------------------------------------------------------------------------
async function viaBridge(tool, args) {
  const root = ensureWorkspace();
  const bridge = bridgeClient.findBridge(root);
  if (!bridge) return null;
  try {
    const result = await bridgeClient.callBridge(bridge, tool, args || {});
    lastBridgeError = null;
    return { ...result, source: 'ide-bridge', workspace: root };
  } catch (e) {
    lastBridgeError = e.message;
    log('bridge failed, fallback to standalone JDT LS: ' + e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 项目模型刷新：桥接模式委托扩展；独立模式用 JDT LS 的通知/请求
// ---------------------------------------------------------------------------
function findBuildFile(root) {
  for (const name of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
    const p = path.join(root, name);
    try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
  }
  return null;
}

async function refreshStandalone(mode, timeoutMs) {
  const root = ensureWorkspace();
  const requested = ['auto', 'build', 'config'].includes(mode) ? mode : 'auto';
  const wantConfig = requested === 'config' || (requested === 'auto' && openedFiles.size >= AUTO_CONFIG_MIN_FILES);
  const started = Date.now();
  try {
    const lsp = await getClient();
    if (wantConfig) {
      const buildFile = findBuildFile(root);
      if (!buildFile) {
        return {
          source: 'standalone-jdtls', ok: false, requested, mode: 'config',
          error: '未找到 pom.xml / build.gradle，无法重载项目',
        };
      }
      const quiet = waitForDiagnosticsQuiet(timeoutMs);
      lsp.notify('java/projectConfigurationUpdate', { uri: pathToFileURL(buildFile).href });
      const completed = await quiet;
      return {
        source: 'standalone-jdtls', ok: true, requested, mode: 'config',
        actions: ['java/projectConfigurationUpdate', buildFile],
        completed, timedOut: !completed, durationMs: Date.now() - started,
      };
    }
    await lsp.request('java/buildWorkspace', false, Math.max(1000, timeoutMs));
    return {
      source: 'standalone-jdtls', ok: true, requested, mode: 'build',
      actions: ['java/buildWorkspace'], completed: true, timedOut: false, durationMs: Date.now() - started,
    };
  } catch (e) {
    return {
      source: 'standalone-jdtls', ok: false, requested, mode: wantConfig ? 'config' : 'build',
      error: e.message, durationMs: Date.now() - started,
    };
  }
}

async function refreshProjectModel(mode, timeoutMs) {
  const root = ensureWorkspace();
  const bridge = bridgeClient.findBridge(root);
  if (bridge) {
    try {
      const result = await bridgeClient.refreshProject(bridge, mode, timeoutMs);
      lastBridgeError = null;
      return { source: 'ide-bridge', workspace: root, ...result };
    } catch (e) {
      lastBridgeError = e.message;
      log('bridge refresh failed: ' + e.message);
      return { source: 'ide-bridge', workspace: root, ok: false, requested: mode, error: e.message };
    }
  }
  return { workspace: root, ...(await refreshStandalone(mode, timeoutMs)) };
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------
async function workspaceSymbols(args) {
  const root = ensureWorkspace();
  const bridged = await viaBridge('workspaceSymbols', args || {});
  if (bridged) return bridged;
  const lsp = await getClient();
  const query = String(args && args.query || '').trim();
  const limit = Math.min(Number(args && args.limit) || 50, 200);
  let result;
  try {
    result = await lsp.request('workspace/symbol', { query }, 25000);
  } catch (e) {
    return {
      workspace: WORKSPACE_ROOT,
      indexStatus,
      ready: serviceReady,
      count: 0,
      items: [],
      note: '索引尚未就绪或查询超时：' + e.message + '。请稍后重试，或先用 java_index_status 查看状态。',
    };
  }
  const out = [];
  for (const item of result || []) {
    const loc = item.location || {};
    let uri = loc.uri;
    let range = loc.range;
    // WorkspaceSymbol 可能带 location 或需要 resolve
    if (!uri && item.data) {
      try {
        const resolved = await lsp.request('workspaceSymbol/resolve', item, 5000);
        uri = resolved.location && resolved.location.uri;
        range = resolved.location && resolved.location.range;
      } catch (_) { /* ignore */ }
    }
    if (!uri) continue;
    out.push({
      name: item.name,
      kind: symbolKindName(item.kind),
      container: item.containerName || '',
      ...locationToJson(uri, range),
    });
    if (out.length >= limit) break;
  }
  return {
    workspace: root,
    count: out.length,
    items: out,
    summary: out.map((i) => `${i.file}:${i.line}:${i.column} ${i.kind} ${i.container ? i.container + '#' : ''}${i.name}`).join('\n'),
  };
}

function lineSnippet(file, line) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    return (lines[line - 1] || '').trim().slice(0, 300);
  } catch (_) {
    return '';
  }
}

function withSnippets(items) {
  return (items || []).map((i) => ({ ...i, text: i.text || lineSnippet(i.file, i.line) }));
}

async function definition(args) {
  const bridged = await viaBridge('definition', args);
  if (bridged) {
    const items = withSnippets(bridged.items);
    return {
      ...bridged,
      count: items.length,
      items,
      summary: items.map((i) => `${i.file}:${i.line}:${i.column} ${i.text || ''}`).join('\n'),
    };
  }
  const file = absoluteFile(args.file);
  const uri = await ensureOpen(file);
  const lsp = await getClient();
  const result = await lsp.request('textDocument/definition', {
    textDocument: { uri },
    position: toPosition(args.line, args.column),
  }, 30000);
  const items = withSnippets(normalizeLocations(result));
  return {
    count: items.length,
    items,
    summary: items.map((i) => `${i.file}:${i.line}:${i.column} ${i.text || ''}`).join('\n'),
  };
}

function referenceLimit(args) {
  // 默认 200 条，limit<=0 表示全部；大仓库引用可能上千条，必须可收窄
  const n = Number(args && args.limit);
  if (Number.isFinite(n)) return n > 0 ? n : 0;
  return 200;
}

async function references(args) {
  const limit = referenceLimit(args);
  const bridged = await viaBridge('references', { ...args, limit: limit > 0 ? limit : undefined });
  if (bridged) {
    const all = bridged.items || [];
    const items = limit > 0 ? all.slice(0, limit) : all;
    const total = Number.isFinite(bridged.count) ? bridged.count : all.length;
    return { ...bridged, count: total, returned: items.length, truncated: items.length < total || bridged.truncated === true, items };
  }
  const file = absoluteFile(args.file);
  const uri = await ensureOpen(file);
  const lsp = await getClient();
  const result = await lsp.request('textDocument/references', {
    textDocument: { uri },
    position: toPosition(args.line, args.column),
    context: { includeDeclaration: args.includeDeclaration !== false },
  }, 60000);
  const all = normalizeLocations(result);
  const items = limit > 0 ? all.slice(0, limit) : all;
  return { count: all.length, returned: items.length, truncated: items.length < all.length, items };
}

function filterSymbols(items, args) {
  const wantName = String((args && args.name) || '').toLowerCase();
  const wantKind = String((args && args.kind) || '').toLowerCase();
  const limit = Math.min(Number((args && args.limit)) || 200, 1000);
  let out = items || [];
  if (wantName) out = out.filter((i) => String(i.name || '').toLowerCase().includes(wantName));
  if (wantKind) out = out.filter((i) => String(i.kind || '').toLowerCase() === wantKind);
  return out.slice(0, limit);
}

function symbolLines(file, items) {
  return items.map((i) =>
    `${file}:${i.line}:${i.column} ${i.kind} ${i.container ? i.container + '#' : ''}${i.name}${i.detail ? '  ' + i.detail : ''}`
  ).join('\n');
}

// 兼容旧版桥接：JDT 的方法名可能带参数列表，统一拆成 name + detail
function normalizeSymbol(i) {
  const raw = String(i.name || '');
  const idx = raw.indexOf('(');
  if (idx < 0) return i;
  const params = raw.slice(idx);
  return {
    ...i,
    name: raw.slice(0, idx),
    kind: i.kind === 'Class' ? 'Method' : i.kind,
    detail: params + (i.detail || ''),
  };
}

async function documentSymbols(args) {
  const file = absoluteFile(args.file);
  const bridged = await viaBridge('documentSymbols', args);
  let items;
  if (bridged) {
    items = filterSymbols((bridged.items || []).map(normalizeSymbol), args);
  } else {
    const uri = await ensureOpen(file);
    const lsp = await getClient();
    const result = await lsp.request('textDocument/documentSymbol', {
      textDocument: { uri },
    }, 30000);
    const flat = [];
    const walk = (nodes, container) => {
      for (const n of nodes || []) {
        const r = n.selectionRange || n.range;
        const raw = String(n.name || '');
        const params = raw.includes('(') ? raw.slice(raw.indexOf('(')) : '';
        flat.push({
          name: params ? raw.slice(0, raw.indexOf('(')) : raw,
          kind: params ? 'Method' : symbolKindName(n.kind),
          container: container || '',
          detail: params + (n.detail || ''),
          ...locationToJson(uri, r),
        });
        if (n.children) walk(n.children, n.name);
      }
    };
    walk(result, '');
    items = filterSymbols(flat, args);
  }
  return { file, source: bridged ? 'ide-bridge' : 'standalone-jdtls', count: items.length, items, summary: symbolLines(file, items) };
}

async function hover(args) {
  const bridged = await viaBridge('hover', args);
  if (bridged) return bridged;
  const file = absoluteFile(args.file);
  const uri = await ensureOpen(file);
  const lsp = await getClient();
  const result = await lsp.request('textDocument/hover', {
    textDocument: { uri },
    position: toPosition(args.line, args.column),
  }, 30000);
  return {
    text: hoverText(result),
    range: result && result.range ? locationToJson(uri, result.range) : null,
  };
}

function collectDiagnostics(severity, limit) {
  const items = [];
  for (const [uri, entry] of diagnosticsByUri.entries()) {
    for (const d of entry.diagnostics || []) {
      items.push({
        file: fromUri(uri),
        line: d.range && d.range.start ? d.range.start.line + 1 : null,
        column: d.range && d.range.start ? d.range.start.character + 1 : null,
        severity: severityName(d.severity),
        message: d.message,
        source: d.source || '',
        code: d.code || '',
      });
    }
  }
  const filtered = filterDiagnostics(items, severity);
  filtered.sort((a, b) => String(a.file).localeCompare(String(b.file)) || (a.line || 0) - (b.line || 0));
  return {
    total: filtered.length,
    allTotal: items.length,
    summary: summarizeDiagnostics(filtered),
    items: filtered.slice(0, Math.min(limit || 200, 1000)),
  };
}

async function fileDiagnostics(args) {
  const bridged = await viaBridge('fileDiagnostics', args);
  if (bridged) return bridged;
  let file;
  try {
    file = absoluteFile(args.file);
  } catch (e) {
    return {
      file: args.file,
      source: 'standalone-jdtls',
      missing: true,
      total: 0,
      allTotal: 0,
      summary: summarizeDiagnostics([]),
      workspaceTotals: workspaceDiagnosticTotals(),
      items: [],
      note: e.message,
    };
  }
  const uri = await ensureOpen(file);
  // 等待 JDT LS 推送诊断
  for (let i = 0; i < 20 && !diagnosticsByUri.has(uri); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const entry = diagnosticsByUri.get(uri);
  const items = (entry && entry.diagnostics || []).map((d) => ({
    file,
    line: d.range && d.range.start ? d.range.start.line + 1 : null,
    column: d.range && d.range.start ? d.range.start.character + 1 : null,
    severity: severityName(d.severity),
    message: d.message,
    source: d.source || '',
  }));
  const filtered = filterDiagnostics(items, args.severity);
  return {
    file,
    source: 'standalone-jdtls',
    total: filtered.length,
    allTotal: items.length,
    summary: summarizeDiagnostics(filtered),
    workspaceTotals: workspaceDiagnosticTotals(),
    items: filtered,
  };
}

async function projectDiagnostics(args) {
  const root = ensureWorkspace();
  const bridged = await viaBridge('projectDiagnostics', args);
  if (bridged) return bridged;
  const lsp = await getClient();
  const severity = args && args.severity || 'error';
  const limit = Number(args && args.limit) || 300;
  try {
    const report = await lsp.request('workspace/diagnostic', {
      identifier: 'java',
      previousResultIds: [],
    }, 30000);
    const items = [];
    for (const doc of (report && report.items) || []) {
      for (const d of doc.items || []) {
        items.push({
          file: fromUri(doc.uri),
          line: d.range && d.range.start ? d.range.start.line + 1 : null,
          column: d.range && d.range.start ? d.range.start.character + 1 : null,
          severity: severityName(d.severity),
          message: d.message,
          source: d.source || '',
        });
      }
    }
    const filtered = filterDiagnostics(items, severity);
    filtered.sort((a, b) => String(a.file).localeCompare(String(b.file)) || (a.line || 0) - (b.line || 0));
    return {
      workspace: root,
      source: 'standalone-jdtls',
      indexStatus,
      total: filtered.length,
      allTotal: items.length,
      summary: summarizeDiagnostics(filtered),
      items: filtered.slice(0, limit),
    };
  } catch (e) {
    // JDT LS 未实现 pull diagnostics 时回退到已推送的诊断
    const fallback = collectDiagnostics(severity, limit);
    return {
      workspace: root,
      source: 'standalone-jdtls',
      indexStatus,
      total: fallback.total,
      items: fallback.items,
      note: 'workspace/diagnostic 不可用，已回退到已打开文件的推送诊断：' + e.message,
    };
  }
}

function lombokStatus() {
  try {
    const found = findLombokJar(findServerDir(bridgeClient.latestRedhatJavaPath()));
    if (found) return { enabled: true, jar: found.jar, source: found.source };
    return { enabled: false, reason: '未找到 lombok agent jar（可设 LOMBOK_JAR）' };
  } catch (e) {
    return { enabled: false, reason: e.message };
  }
}

function bridgeLombok(bridge) {
  if (bridge.lombokExtension || bridge.lombokJar) {
    return {
      enabled: !!bridge.lombokJar,
      extension: bridge.lombokExtension || null,
      jar: bridge.lombokJar || null,
      source: 'ide-bridge',
    };
  }
  return lombokStatus();
}

async function indexStatusTool() {
  let root = null;
  try {
    root = ensureWorkspace();
  } catch (e) {
    return {
      workspace: null,
      source: 'none',
      status: 'NoWorkspace',
      ready: false,
      bridgeError: lastBridgeError,
      error: e.message,
      note: 'MCP 比 IDE 扩展更早启动时需稍后重试；也可显式设置 JAVA_NAV_WORKSPACE。',
    };
  }
  const bridge = bridgeClient.findBridge(root);
  if (bridge) {
    // 桥接同步统计属于可观测性信息，失败不影响状态查询
    let sync = null;
    try { sync = (await bridgeClient.health(bridge)).sync || null; } catch (_) { /* ignore */ }
    return {
      workspace: root,
      source: 'ide-bridge',
      status: 'ServiceReady',
      ready: true,
      windowId: bridge.windowId || null,
      bridgeError: lastBridgeError,
      projectJavaVersion: PROJECT_JAVA_VERSION,
      configuredRuntimes: JAVA_SETTINGS.runtimes.map((r) => r.name || r.path),
      redhatJava: { active: bridge.redhatJavaActive === true, path: bridge.redhatJavaPath || null },
      lombok: bridgeLombok(bridge),
      sync,
      note: 'IDE 已按 Trae 的 java.configuration.runtimes 与 Maven 配置分析项目',
      bridge: {
        port: bridge.port,
        pid: bridge.pid,
        windowId: bridge.windowId || null,
        appName: bridge.appName || null,
        workspaceFolders: bridge.workspaceFolders,
        startedAt: bridge.startedAt,
      },
    };
  }
  return {
      workspace: root,
      source: 'standalone-jdtls',
      status: indexStatus,
      ready: serviceReady,
      bridgeError: lastBridgeError,
      projectJavaVersion: PROJECT_JAVA_VERSION,
      configuredRuntimes: JAVA_SETTINGS.runtimes.map((r) => r.name || r.path),
      lombok: lombokStatus(),
      openedFiles: openedFiles.size,
      filesWithDiagnostics: diagnosticsByUri.size,
    };
}

async function warmup() {
  let root;
  try {
    root = ensureWorkspace();
  } catch (e) {
    return { status: 'no-workspace', source: 'none', error: e.message };
  }
  const bridge = bridgeClient.findBridge(root);
  if (bridge) {
    let sync = null;
    try { sync = (await bridgeClient.health(bridge)).sync || null; } catch (_) { /* ignore */ }
    return {
      status: 'ready',
      source: 'ide-bridge',
      workspace: root,
      sync,
      note: '桥接模式索引已就绪，warmup 只对独立 JDT LS 有效，不会刷新项目模型；项目陈旧请用 java_status {refresh:"auto"} 或 java_diagnostics {refresh:"config"}。',
    };
  }
  getClient().catch((e) => log('warmup failed: ' + e.message));
  return { status: 'starting', source: 'standalone-jdtls', workspace: root };
}

// ---------------------------------------------------------------------------
// MCP 工具表
// ---------------------------------------------------------------------------
async function javaSearch(args) {
  const a = args || {};
  const mode = a.mode ? String(a.mode).toLowerCase() : '';
  if (mode) {
    if (!['workspace', 'class', 'file', 'outline'].includes(mode)) {
      throw new Error('未知 mode: ' + a.mode + '（可选 workspace / class / file / outline）');
    }
    if (mode === 'workspace' && !a.query) throw new Error('mode=workspace 需要 query（类名、前缀或 Class#method）');
    if (mode === 'class' && !a.class) throw new Error('mode=class 需要 class（类名）');
    if ((mode === 'file' || mode === 'outline') && !a.file) throw new Error('mode=' + mode + ' 需要 file（文件路径）');
    if (mode === 'file' && !a.name) throw new Error('mode=file 需要 name（成员名）；只想看文件结构请用 mode=outline');
    const rest = { ...a, mode: undefined };
    if (mode === 'outline') rest.name = undefined;
    return { mode, ...(await javaSearch(rest)) };
  }
  // 只知道类名：先定位类文件，再在文件内查符号（一次调用完成 “X 类里 Y 在哪”）
  if (!a.file && a.class) {
    const cls = String(a.class).trim();
    const found = await workspaceSymbols({ query: cls, limit: 20 });
    const cand = (found.items || []).find((i) => i.name === cls && /Class|Interface|Enum|Record/.test(i.kind))
      || (found.items || [])[0];
    if (!cand) throw new Error('未找到类 ' + cls + '（可用 query 搜索或直接给 file）');
    return await javaSearch({
      ...a,
      class: undefined,
      file: cand.file,
      container: a.container || cls,
    });
  }
  if (!a.file && a.query && String(a.query).includes('#')) {
    const [cls, nm] = String(a.query).split('#');
    return await javaSearch({ ...a, query: undefined, class: cls, name: a.name || nm });
  }
  if (a.file) {
    const file = absoluteFile(a.file);
    if (a.name) {
      const doc = await documentSymbols({ file, name: a.name, kind: a.kind, limit: a.limit || 50 });
      let items = doc.items || [];
      const exact = items.filter((i) => i.name === a.name);
      if (exact.length) items = exact;
      if (a.container) {
        const c = String(a.container).toLowerCase();
        const scoped = items.filter((i) => String(i.container || '').toLowerCase().includes(c));
        if (scoped.length) items = scoped;
      }
      return {
        mode: 'file-lookup',
        source: doc.source,
        file,
        query: a.name,
        count: items.length,
        items,
        summary: items.length ? symbolLines(file, items) : `未在 ${file} 中找到符号 ${a.name}`,
      };
    }
    const doc = await documentSymbols({ file, kind: a.kind, limit: a.limit || 200 });
    return { mode: 'file-symbols', ...doc };
  }
  const query = String(a.query || '').trim();
  if (!query) throw new Error('缺少 query 或 file：工作区搜索用 query，文件内定位用 file + name');
  return { mode: 'workspace', ...(await workspaceSymbols({ query, limit: a.limit })) };
}

async function javaNavigate(args) {
  const a = args || {};
  const action = String(a.action || 'definition');
  if (action === 'definition') return { action, ...(await definition(a)) };
  if (action === 'references') {
    const r = await references(a);
    const summary = (r.items || []).map((i) => `${i.file}:${i.line}:${i.column}`).join('\n')
      + (r.truncated ? `\n… 已截断，共 ${r.count} 条（limit=${a.limit == null ? 200 : a.limit}）` : '');
    return {
      action,
      ...r,
      summary,
    };
  }
  if (action === 'hover') return { action, ...(await hover(a)) };
  throw new Error('未知 action: ' + action + '（可选 definition / references / hover）');
}

async function javaDiagnostics(args) {
  const a = args || {};
  let refresh = null;
  if (a.refresh && a.refresh !== 'none') {
    refresh = await refreshProjectModel(a.refresh, REFRESH_WAIT_MS);
  }
  const result = a.file
    ? { scope: 'file', ...(await fileDiagnostics({ file: a.file, severity: a.severity || 'all' })) }
    : { scope: 'project', ...(await projectDiagnostics({ severity: a.severity || 'error', limit: a.limit })) };
  return refresh ? { ...result, refresh } : result;
}

async function javaStatus(args) {
  const a = args || {};
  if (a.refresh && a.refresh !== 'none') {
    const refresh = await refreshProjectModel(a.refresh, REFRESH_WAIT_MS);
    const status = await indexStatusTool();
    return { ...status, refresh };
  }
  if (a.warmup === true) return await warmup();
  return await indexStatusTool();
}

// ---------------------------------------------------------------------------
// MCP 工具表（4 个工具，覆盖全部能力，控制上下文体积）
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'java_search',
    description: '定位 Java 符号位置。先按意图选 mode（一次调用即可，不要先猜参数再重试）：workspace=只知道名字，传 query（支持 Class#method）；class=知道类名，传 class（可加 name/kind 定位成员）；file=知道文件与成员名，传 file+name；outline=只看文件结构，传 file。省略 mode 时按已有参数自动推断。返回 count/items[{name,kind,container,file,line,column}] 与 summary。适合：不知道声明文件、区分同名/重载、一次定位类内成员。已知文件位置只想读代码、纯文本/非 Java/生成源码请用 Read/Grep。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['workspace', 'class', 'file', 'outline'],
          description: '查询模式，决定必填参数：workspace→query；class→class（可选 name/kind）；file→file+name；outline→file。推荐显式传入',
        },
        query: {
          type: 'string',
          description: 'mode=workspace 时必填。符号名/前缀，或 Class#method。例：OrderService、QualityController#alerts',
        },
        class: {
          type: 'string',
          description: 'mode=class 时必填。完整或简单类名。例：OrderService',
        },
        file: {
          type: 'string',
          description: 'mode=file 或 outline 时必填。绝对路径，或相对工作区的路径；也可写成“工程目录名/相对路径”。文件被移动或删除时会提示不存在，可改用 mode=workspace 按符号名定位新位置。例：src/main/java/com/example/OrderService.java',
        },
        name: {
          type: 'string',
          description: 'mode=file 时必填；mode=class 时可选。成员名或子串。例：createOrder',
        },
        container: {
          type: 'string',
          description: '可选。限定外层类名，用于消除同名符号歧义',
        },
        kind: {
          type: 'string',
          description: '可选。进一步过滤：Method / Field / Class / Interface / Enum / Constructor',
        },
        limit: {
          type: 'number',
          description: '可选。返回上限：workspace 默认 50，class/file/outline 默认 200，最大 1000',
        },
      },
      anyOf: [
        { required: ['query'] },
        { required: ['class'] },
        { required: ['file'] },
      ],
      examples: [
        { mode: 'workspace', query: 'OrderService', limit: 10 },
        { mode: 'class', class: 'OrderService', name: 'createOrder', kind: 'Method' },
        { mode: 'file', file: 'src/main/java/com/example/OrderService.java', name: 'createOrder' },
        { mode: 'outline', file: 'src/main/java/com/example/OrderService.java' },
      ],
    },
  },
  {
    name: 'java_navigate',
    description: '在已知位置做 Java 语义导航。action：definition（默认，跳定义并返回源码行）/ references（引用与调用方）/ hover（签名与文档）。file/line/column 必填，行列从 1 开始且必须落在标识符首字符；落在包前缀、空白或标点会返回 0 条。references 默认前 200 条（limit=0 为全部），返回 count（总数）/returned/truncated/items。需要实现/类型/调用层次或重构时本工具不提供。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['definition', 'references', 'hover'],
          description: '导航类型，默认 definition。definition=跳定义；references=找引用；hover=看签名/文档',
        },
        file: { type: 'string', description: '文件绝对路径或相对 Java 工程根路径' },
        line: { type: 'number', description: '从 1 开始，必须落在标识符所在行' },
        column: { type: 'number', description: '从 1 开始的字符偏移（Tab 算 1 个字符），必须指向标识符第一个字符' },
        includeDeclaration: { type: 'boolean', description: 'references 是否包含声明，默认 true（桥接模式下始终包含）' },
        limit: { type: 'number', description: 'references 返回上限，默认 200；0 表示全部。count 为总数，truncated=true 表示被截断' },
      },
      required: ['file', 'line', 'column'],
      examples: [
        { action: 'definition', file: 'src/main/java/com/example/OrderService.java', line: 88, column: 17 },
        { action: 'references', file: 'src/main/java/com/example/OrderService.java', line: 42, column: 18, limit: 200 },
      ],
    },
  },
  {
    name: 'java_diagnostics',
    description: '读取 IDE 中 JDT LS 的实时编译错误/警告，替代反复执行 Maven 做快速反馈。给 file 查单文件（默认全部级别）；不给 file 查整个工作区（默认只查 error）。返回 total（本次 severity 过滤后的条目数，与 Problems 面板同级别条数一致）、allTotal（全部级别条数）、summary（按 severity/source/language/code 的计数）以及每条 file/line/column/severity/code/message。文件模式还返回 workspaceTotals（整个工作区按 severity/source/language 的残留计数）：文件 total=0 只说明该文件干净，不代表工作区清零；汇报“警告/错误已全部解决”前必须看 workspaceTotals 或用工作区模式复查，并区分 source（sonarqube 与 Java/JDT 是两套问题，unused import 等属于 Java）。文件已被移动或删除时返回 missing:true（total=0）而不是报错；工作区模式会过滤这些已不存在文件的幽灵诊断，并在 skippedMissing/missingFiles 中报告，IDE Problems 面板可能仍显示它们，重载窗口可清除。报数一律用 total/summary/workspaceTotals，不要自行统计 items 行数。适合：cannot be resolved、找不到符号、类型不匹配、import 报错、查看错误分布。不适合：最终编译门禁（仍需 mvn/mvnw test-compile）、非 Java 文件 lint、依赖/配置问题。桥接模式附带 consistency：current/reloaded 可直接使用；dirty（有未保存修改）与 unknown（检查失败）不要据此下结论；工作区 needsRefresh=true 表示项目模型滞后，用 refresh:"auto" 刷新后重查，仍陈旧用 refresh:"config" 强制完整重载。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '可选。单文件路径（绝对或相对工作区）；省略则查整个工作区' },
        severity: { type: 'string', enum: ['all', 'error', 'warning', 'info', 'hint'], description: '过滤级别：文件模式默认 all，工作区模式默认 error' },
        limit: { type: 'number', description: '可选。工作区模式返回上限，默认 300（最大 1000）' },
        refresh: {
          type: 'string',
          enum: ['none', 'auto', 'build', 'config'],
          description: '可选。返回前刷新项目模型：auto=按变更规模自动选择（模型陈旧时优先 config）；build=增量编译（快）；config=完整重载（java.projectConfiguration.update，较慢但能修复批量移动/重命名后的模型错位）。默认 none',
        },
      },
      examples: [
        { file: 'src/main/java/com/example/OrderService.java', severity: 'all' },
        { severity: 'error', limit: 100 },
        { refresh: 'auto', severity: 'error', limit: 100 },
        { refresh: 'config' },
      ],
    },
  },
  {
    name: 'java_status',
    description: '查看数据源（ide-bridge / standalone-jdtls）、索引状态、redhat.java 与 Lombok 探测；refresh 可在返回前刷新项目模型（桥接模式直接触发 JDT 刷新，独立模式发送 java/projectConfigurationUpdate / java/buildWorkspace）。先看 source：ide-bridge 表示语义查询毫秒级；standalone 建议 warmup 预热后复用。桥接模式还返回 sync（noopChecks / reloadedCount / dirtyConflicts / circuitBroken / lastBuildMode / lastModelRefreshAt / projectDirty）。适合：首次使用前确认、needsRefresh 清不掉、怀疑项目模型陈旧、多窗口定位。',
    inputSchema: {
      type: 'object',
      properties: {
        refresh: {
          type: 'string',
          enum: ['none', 'auto', 'build', 'config'],
          description: '刷新项目模型后再返回状态：auto=按变更规模选择；build=增量编译；config=完整重载（java.projectConfiguration.update）。模型明显陈旧或批量移动文件后用 auto/config',
        },
        warmup: { type: 'boolean', description: '仅对独立 JDT LS 有效：后台启动索引。桥接模式已就绪，该参数不会刷新项目模型' },
      },
      examples: [
        { refresh: 'auto' },
        { warmup: true },
      ],
    },
  },
];

const HANDLERS = {
  java_search: javaSearch,
  java_navigate: javaNavigate,
  java_diagnostics: javaDiagnostics,
  java_status: javaStatus,
};
// ---------------------------------------------------------------------------
// MCP 请求分发
// ---------------------------------------------------------------------------
async function handleRequest(msg) {
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'trae-java-navigator', version: SERVER_VERSION },
          instructions: [
            '本服务器提供 Java 语义导航：java_search（工作区/类内/文件内符号定位）、java_navigate（definition/references/hover）、java_diagnostics（实时编译错误）、java_status（数据源与索引状态）。',
            'java_search 用 mode 明确意图（workspace=query / class=class / file=file+name / outline=file），一次调用即可，不要先猜参数再重试；省略 mode 时按参数自动推断。',
            '选择方式按“总耗时最短且结果可靠”，没有固定优先级：已知文件与位置只想读代码，直接 Read；不知道符号在哪个文件，用 java_search；需要真实引用/定义/签名（排除注释、字符串、同名测试假阳性）用 java_navigate；快速看编译错误用 java_diagnostics。',
            '成本提示：桥接模式（source=ide-bridge）索引已就绪，语义查询通常毫秒级；独立 JDT LS 冷启动可能数十秒，小任务先用 Read/Grep，同时 java_status {warmup:true} 预热。文本内容、非 Java 文件、工程外或 target/ 生成源码，Grep/Read 更直接。',
            '工具返回 0 条或报错时回退文本搜索并说明原因；工具只读，不做重命名/重构、调用/类型/实现层次；IDE 诊断不能替代编译门禁（最终仍需 mvn/mvnw test-compile）。',
            '诊断结果带 consistency：current/reloaded 可正常使用；dirty 表示编辑器有未保存修改，unknown 表示一致性检查失败，这两种情况不要据此下结论；工作区模式 needsRefresh=true 时项目模型滞后。',
            '项目模型陈旧时用 java_diagnostics {refresh:"auto"} 或 java_status {refresh:"auto"} 触发刷新；批量移动/重命名大量文件后用 refresh:"config" 做完整重载（扩展内部调用 java.projectConfiguration.update）。不要修改 pom.xml 时间戳，也不要依赖 warmup（它只启动独立 JDT LS）。',
          ].join(' '),
        },
      });
      return;
    }
    if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }
    if (method === 'tools/call') {
      const name = params && params.name;
      const handler = HANDLERS[name];
      if (!handler) throw new Error('未知工具: ' + name);
      const result = await handler(params.arguments || {});
      send({
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: false,
        },
      });
      if (process.env.JAVA_NAV_EXIT_AFTER_TOOL === '1') {
        setTimeout(() => {
          try { if (client) client.stop(); } catch (_) { /* ignore */ }
          process.exit(0);
        }, 100);
      }
      return;
    }
    if (method === 'notifications/initialized' || method === 'initialized') {
      return;
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  } catch (e) {
    if (id !== undefined) {
      send({
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: 'ERROR: ' + e.message }],
          isError: true,
        },
      });
    } else {
      log('notification error: ' + e.message);
    }
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let pendingRequests = 0;
let stdinClosed = false;
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch (e) { log('bad json: ' + e.message); return; }
  if (msg.id !== undefined) {
    pendingRequests++;
    handleRequest(msg).finally(() => {
      pendingRequests--;
      if (stdinClosed && pendingRequests === 0) shutdown();
    });
  } else if (msg.method) {
    // 通知（如 notifications/cancelled）不需要响应
    if (msg.method === 'notifications/cancelled') return;
  }
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { if (client) client.stop(); } catch (_) { /* ignore */ }
  process.exit(0);
}

function onStdinClosed() {
  stdinClosed = true;
  if (pendingRequests === 0) shutdown();
}

rl.on('close', onStdinClosed);
process.stdin.on('end', onStdinClosed);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('exit', () => { try { client && client.stop(); } catch (_) { /* ignore */ } });

log('java-navigator MCP server started; workspace will be resolved on first tool call');

// 安装时删不掉的旧版本目录：此时旧 MCP 进程已退出，延迟几秒后按 pending 列表清理
setTimeout(() => {
  try {
    const result = cleanupPendingVersions({ log });
    if (result && result.removed) log('pending cleanup: removed ' + result.removed);
  } catch (e) {
    log('pending cleanup failed: ' + e.message);
  }
}, 3000).unref();