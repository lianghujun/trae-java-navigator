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
      clientInfo: { name: 'trae-java-navigator', version: '0.1.0' },
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
function absoluteFile(file) {
  if (!file) throw new Error('缺少 file 参数');
  const p = path.isAbsolute(file) ? file : path.resolve(ensureWorkspace(), file);
  if (!fs.existsSync(p)) throw new Error('文件不存在: ' + p);
  return p;
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

async function references(args) {
  const bridged = await viaBridge('references', args);
  if (bridged) return bridged;
  const file = absoluteFile(args.file);
  const uri = await ensureOpen(file);
  const lsp = await getClient();
  const result = await lsp.request('textDocument/references', {
    textDocument: { uri },
    position: toPosition(args.line, args.column),
    context: { includeDeclaration: args.includeDeclaration !== false },
  }, 60000);
  const items = normalizeLocations(result);
  return { count: items.length, items };
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
  return { total: filtered.length, items: filtered.slice(0, Math.min(limit || 200, 1000)) };
}

async function fileDiagnostics(args) {
  const bridged = await viaBridge('fileDiagnostics', args);
  if (bridged) return bridged;
  const file = absoluteFile(args.file);
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
  return { file, total: filtered.length, items: filtered };
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
      indexStatus,
      total: filtered.length,
      items: filtered.slice(0, limit),
    };
  } catch (e) {
    // JDT LS 未实现 pull diagnostics 时回退到已推送的诊断
    const fallback = collectDiagnostics(severity, limit);
    return {
      workspace: root,
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

function indexStatusTool() {
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
    return { status: 'ready', source: 'ide-bridge', workspace: root };
  }
  getClient().catch((e) => log('warmup failed: ' + e.message));
  return { status: 'starting', source: 'standalone-jdtls', workspace: root };
}

// ---------------------------------------------------------------------------
// MCP 工具表
// ---------------------------------------------------------------------------
async function javaSearch(args) {
  const a = args || {};
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
    return {
      action,
      ...r,
      summary: (r.items || []).map((i) => `${i.file}:${i.line}:${i.column}`).join('\n'),
    };
  }
  if (action === 'hover') return { action, ...(await hover(a)) };
  throw new Error('未知 action: ' + action + '（可选 definition / references / hover）');
}

async function javaDiagnostics(args) {
  const a = args || {};
  if (a.file) return { scope: 'file', ...(await fileDiagnostics({ file: a.file, severity: a.severity || 'all' })) };
  return { scope: 'project', ...(await projectDiagnostics({ severity: a.severity || 'error', limit: a.limit })) };
}

async function javaStatus(args) {
  const a = args || {};
  if (a.warmup === true) return await warmup();
  return indexStatusTool();
}

// ---------------------------------------------------------------------------
// MCP 工具表（4 个工具，覆盖全部能力，控制上下文体积）
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'java_search',
    description: '查找 Java 符号（首选，不要用 Grep 查 Java 符号）：query=工作区（支持 Class#method）、class+name=类内定位、file+name=文件内定位、只给 file=结构。返回精确行列与签名，优先读 summary。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '工作区符号名或前缀，也可写 Class#method，例如 QualityController#alerts' },
        class: { type: 'string', description: '类名；与 name 搭配可一次定位类内方法/字段' },
        file: { type: 'string', description: '文件路径（绝对或相对工作区）' },
        name: { type: 'string', description: '文件内符号名或子串，例如 getRule' },
        container: { type: 'string', description: '限定外层类名' },
        kind: { type: 'string', description: 'Method / Field / Class' },
        limit: { type: 'number', description: '返回上限；工作区默认 50，文件默认 200' },
      },
    },
  },
  {
    name: 'java_navigate',
    description: '按位置导航 Java 符号。action=definition（默认，含源码行）、references（全部引用）、hover（类型/签名/文档）。行列从 1 开始。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['definition', 'references', 'hover'], description: '默认 definition' },
        file: { type: 'string' },
        line: { type: 'number' },
        column: { type: 'number' },
        includeDeclaration: { type: 'boolean', description: 'references 是否包含声明，默认 true' },
      },
      required: ['file', 'line', 'column'],
    },
  },
  {
    name: 'java_diagnostics',
    description: '读取实时编译错误/警告。给 file 查单文件；不给 file 查整个工作区。优先桥接的 IDE 诊断。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '可选；省略则查整个工作区' },
        severity: { type: 'string', enum: ['all', 'error', 'warning', 'info', 'hint'], description: '文件默认 all，工作区默认 error' },
        limit: { type: 'number', description: '工作区上限，默认 300' },
      },
    },
  },
  {
    name: 'java_status',
    description: '查看数据源（ide-bridge / standalone-jdtls）、索引状态、redhat.java 与 Lombok 探测。warmup=true 时后台启动索引。',
    inputSchema: {
      type: 'object',
      properties: {
        warmup: { type: 'boolean', description: '后台启动 JDT LS 并开始建索引' },
      },
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
          serverInfo: { name: 'trae-java-navigator', version: '0.1.0' },
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