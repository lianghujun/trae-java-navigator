'use strict';

// 插件升级时，旧版本目录可能正被运行中的 MCP 进程当作 cwd，Windows 无法当场删除。
// 安装器会把这类目录写入插件父目录的 .pending-cleanup.json；
// 新版 MCP 完全启动（旧进程已退出）后再按列表清理。

const fs = require('fs');
const path = require('path');

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const RETIRED_PREFIX = '.old-';

function parseVersion(name) {
  const m = VERSION_RE.exec(String(name || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// 已改名待删除目录：.old-<version>-<timestamp>
function retiredVersion(name) {
  if (!String(name || '').startsWith(RETIRED_PREFIX)) return null;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(name).slice(RETIRED_PREFIX.length));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function samePath(a, b) {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function isInside(parent, target) {
  const rel = path.relative(path.resolve(parent), path.resolve(target));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function cleanupPendingVersions(options) {
  const opts = options || {};
  const log = opts.log || (() => {});
  const pluginDir = path.resolve(opts.pluginDir || path.join(__dirname, '..'));
  const parent = path.dirname(pluginDir);
  const currentName = path.basename(pluginDir);
  const current = parseVersion(currentName);
  // 开发态（直接在仓库里运行 server/mcp-server.js）没有版本号目录，不参与清理
  if (!current) return { skipped: 'not-installed-layout' };

  const file = path.join(parent, '.pending-cleanup.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return { skipped: 'no-pending-file' };
  }

  const entries = Array.isArray(data.pending) ? data.pending : [];
  const remaining = [];
  let removed = 0;

  for (const entry of entries) {
    const raw = entry && entry.path;
    if (!raw || typeof raw !== 'string') continue;
    const target = path.resolve(raw);
    if (!isInside(parent, target) || samePath(target, pluginDir)) continue;

    const name = path.basename(target);
    const version = parseVersion(name) || retiredVersion(name);
    // 只清理旧版本或安装器改名后的待删除目录，绝不碰当前版本/更新版本
    if (!version || (parseVersion(name) && compareVersion(version, current) >= 0)) continue;

    if (!fs.existsSync(target)) {
      removed++;
      continue;
    }
    // 先摘掉 .success，确保即使删除失败，Trae 也不会把该目录当作可用版本
    try { fs.unlinkSync(path.join(target, '.success')); } catch (_) { /* ignore */ }
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      removed++;
      log('已清理旧版本目录 ' + target);
    } catch (e) {
      remaining.push({
        path: target,
        reason: e.code || e.message,
        at: new Date().toISOString(),
      });
      log('旧版本目录仍被占用，保留到下次启动清理：' + target + '（' + (e.code || e.message) + '）');
    }
  }

  try {
    if (!remaining.length) fs.unlinkSync(file);
    else {
      fs.writeFileSync(file, JSON.stringify({
        current: currentName,
        updatedAt: new Date().toISOString(),
        pending: remaining,
      }, null, 2), 'utf8');
    }
  } catch (_) { /* ignore */ }

  return { removed, remaining: remaining.length };
}

module.exports = { cleanupPendingVersions, parseVersion, compareVersion };