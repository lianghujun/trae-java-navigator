#!/usr/bin/env node
'use strict';

// 跨平台安装器：Windows / macOS / Linux
// 用法：node install.mjs [--plugins-root <dir>]
// 也可用环境变量 TRAE_PLUGINS_ROOT 覆盖。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const src = path.dirname(fileURLToPath(import.meta.url));
const pluginJson = JSON.parse(fs.readFileSync(path.join(src, '.trae-plugin', 'plugin.json'), 'utf8'));
const pluginName = pluginJson.name || 'trae-java-navigator';
const version = pluginJson.version || '0.1.0';

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}

function candidates() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const out = [];
  if (process.platform === 'win32') {
    out.push(path.join(home, '.trae-cn', 'plugins'));
    out.push(path.join(home, '.trae', 'plugins'));
    out.push(path.join(appData, 'Trae CN', 'plugins'));
    out.push(path.join(appData, 'Trae', 'plugins'));
    out.push(path.join(appData, 'Code', 'plugins'));
    out.push(path.join(appData, 'Cursor', 'plugins'));
    out.push(path.join(appData, 'VSCodium', 'plugins'));
  } else if (process.platform === 'darwin') {
    for (const n of ['Trae CN', 'Trae', 'Code', 'Cursor', 'VSCodium']) {
      out.push(path.join(home, 'Library', 'Application Support', n, 'plugins'));
    }
    out.push(path.join(home, '.trae-cn', 'plugins'));
    out.push(path.join(home, '.trae', 'plugins'));
  } else {
    for (const n of ['Trae CN', 'Trae', 'Code', 'Cursor', 'VSCodium']) {
      out.push(path.join(home, '.config', n, 'plugins'));
    }
    out.push(path.join(home, '.trae-cn', 'plugins'));
    out.push(path.join(home, '.trae', 'plugins'));
  }
  return [...new Set(out)];
}

function resolvePluginsRoot() {
  const explicit = argValue('--plugins-root') || process.env.TRAE_PLUGINS_ROOT;
  if (explicit) return path.resolve(explicit);
  for (const c of candidates()) {
    if (fs.existsSync(c)) return c;
  }
  return candidates()[0];
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  // 仅开发/社区用的文件不进入插件安装目录
  const skip = new Set(['node_modules', 'dist', 'bench', 'docs', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md']);
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.has(entry.name) || entry.name.endsWith('.zip')) continue;
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// 覆盖安装时清理源目录已不存在的文件（例如被替换的旧图标）
function pruneExtra(from, to) {
  for (const entry of fs.readdirSync(to, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (!fs.existsSync(s)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* ignore */ }
      continue;
    }
    if (entry.isDirectory()) pruneExtra(s, d);
  }
}

const pluginsRoot = resolvePluginsRoot();
const pluginParent = path.join(pluginsRoot, 'local', pluginName);
const target = path.join(pluginParent, version);
// 升级时只保留当前版本，避免 Trae 同时看到多个版本
if (fs.existsSync(pluginParent)) {
  for (const name of fs.readdirSync(pluginParent)) {
    if (name === version) continue;
    try { fs.rmSync(path.join(pluginParent, name), { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}
// 插件启用中时目录可能被占用（Windows EBUSY）：退化为覆盖复制
try {
  fs.rmSync(target, { recursive: true, force: true });
} catch (e) {
  console.log('安装目录正被运行中的插件占用，改为覆盖复制（Reload 后生效）：' + e.message);
}
copyDir(src, target);
pruneExtra(src, target);

const mcpPath = path.join(target, '.mcp.json');
const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
const mcpArgs = (mcp.mcpServers['java-navigator'] || {}).args || [];
// Trae 以插件版本目录作为 MCP 进程 cwd，必须用相对路径，升级换目录才不会失效
if (!mcpArgs.length || path.isAbsolute(mcpArgs[0])) {
  console.error('.mcp.json 必须使用相对路径（例如 "./server/mcp-server.js"）：' + JSON.stringify(mcpArgs));
  process.exit(1);
}
if (!fs.existsSync(path.join(target, mcpArgs[0].replace(/^\.\//, '')))) {
  console.error('MCP 入口不存在：' + mcpArgs[0]);
  process.exit(1);
}

fs.writeFileSync(path.join(target, '.success'), JSON.stringify({
  logical_name: 'local:' + pluginName,
  registry: 'local',
  plugin_name: pluginName,
  version,
  installed_at: Math.floor(Date.now() / 1000),
}, null, 2), 'utf8');

function findIdeCli() {
  const explicit = process.env.TRAE_CLI || null;
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const names = process.platform === 'win32'
    ? ['trae-cn.cmd', 'trae.cmd', 'code.cmd']
    : ['trae-cn', 'trae', 'code'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// 随包携带桥接扩展 VSIX，一条命令同时完成插件 + 扩展安装
function installBundledExtension() {
  const vsix = path.join(src, 'vendor', 'trae-java-bridge.vsix');
  if (!fs.existsSync(vsix)) return;
  const cli = findIdeCli();
  if (!cli) {
    console.log('未找到 IDE CLI，跳过桥接扩展安装。可在 IDE 中手动“从 VSIX 安装”：' + vsix);
    return;
  }
  console.log('安装桥接扩展：' + vsix);
  const r = spawnSync(`"${cli}" --install-extension "${vsix}" --force`, { shell: true, stdio: 'inherit' });
  if (r.status !== 0) {
    console.log('桥接扩展安装失败，可在 IDE 中手动“从 VSIX 安装”：' + vsix);
  }
}

console.log('Installed to ' + target);
installBundledExtension();
console.log('完全退出并重启 Trae（不是仅 Reload），插件与 MCP 才会按新配置重新登记。');