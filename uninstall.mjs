#!/usr/bin/env node
'use strict';

// 卸载器：删除已安装插件目录、兜底 JDT LS 缓存与空桥接目录。
// 用法：node uninstall.mjs [--plugins-root <dir>] [--all]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pluginName = 'trae-java-navigator';

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}

function candidates() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const out = [];
  if (process.platform === 'win32') {
    out.push(path.join(home, '.trae-cn', 'plugins'), path.join(home, '.trae', 'plugins'));
    for (const n of ['Trae CN', 'Trae', 'Code', 'Cursor', 'VSCodium']) {
      out.push(path.join(appData, n, 'plugins'));
    }
  } else if (process.platform === 'darwin') {
    for (const n of ['Trae CN', 'Trae', 'Code', 'Cursor', 'VSCodium']) {
      out.push(path.join(home, 'Library', 'Application Support', n, 'plugins'));
    }
    out.push(path.join(home, '.trae-cn', 'plugins'), path.join(home, '.trae', 'plugins'));
  } else {
    for (const n of ['Trae CN', 'Trae', 'Code', 'Cursor', 'VSCodium']) {
      out.push(path.join(home, '.config', n, 'plugins'));
    }
    out.push(path.join(home, '.trae-cn', 'plugins'), path.join(home, '.trae', 'plugins'));
  }
  return [...new Set(out)];
}

const explicit = argValue('--plugins-root') || process.env.TRAE_PLUGINS_ROOT;
const roots = explicit ? [path.resolve(explicit)] : candidates();

let removed = 0;
for (const root of roots) {
  const dir = path.join(root, 'local', pluginName);
  if (!fs.existsSync(dir)) continue;
  fs.rmSync(dir, { recursive: true, force: true });
  removed++;
  console.log('Removed ' + dir);
}

const cacheDir = process.env.TRAE_JAVA_NAV_CACHE
  ? path.join(process.env.TRAE_JAVA_NAV_CACHE, 'trae-java-navigator')
  : path.join(os.tmpdir(), 'trae-java-navigator');
if (fs.existsSync(cacheDir)) {
  fs.rmSync(cacheDir, { recursive: true, force: true });
  console.log('Removed cache ' + cacheDir);
}

const bridgeDir = process.env.JAVA_NAV_BRIDGE_DIR
  || process.env.TRAE_JAVA_BRIDGE_DIR
  || path.join(os.tmpdir(), 'trae-java-bridge');
try {
  if (fs.existsSync(bridgeDir) && !fs.readdirSync(bridgeDir).length) {
    fs.rmdirSync(bridgeDir);
    console.log('Removed empty bridge dir ' + bridgeDir);
  }
} catch (_) { /* ignore */ }

console.log(removed ? 'Uninstalled. Reload the IDE window.' : 'Plugin directory not found; nothing to remove.');