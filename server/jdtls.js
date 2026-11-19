'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function firstExisting(paths, predicate) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p) && (!predicate || predicate(p))) return p;
    } catch (_) { /* ignore */ }
  }
  return null;
}

function extensionSearchRoots() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const roots = [];
  if (process.env.JAVA_NAV_IDE_HOME) roots.push(process.env.JAVA_NAV_IDE_HOME);
  if (process.env.TRAE_HOME) roots.push(process.env.TRAE_HOME);
  if (process.platform === 'win32') {
    for (const n of ['Trae CN', 'Trae', 'Code', 'Cursor', 'VSCodium']) {
      roots.push(path.join(appData, n, 'extensions'));
      roots.push(path.join(home, '.' + n.toLowerCase().replace(/\s+/g, ''), 'extensions'));
    }
  } else if (process.platform === 'darwin') {
    for (const n of ['Trae CN', 'Trae', 'Code', 'Cursor', 'VSCodium']) {
      roots.push(path.join(home, 'Library', 'Application Support', n, 'extensions'));
      roots.push(path.join(home, '.' + n.toLowerCase().replace(/\s+/g, ''), 'extensions'));
    }
  } else {
    for (const n of ['Trae CN', 'Trae', 'Code', 'Cursor', 'VSCodium']) {
      roots.push(path.join(home, '.config', n, 'extensions'));
      roots.push(path.join(home, '.' + n.toLowerCase().replace(/\s+/g, ''), 'extensions'));
    }
  }
  roots.push(path.join(home, '.vscode', 'extensions'));
  roots.push(path.join(home, '.trae-cn', 'extensions'));
  roots.push(path.join(home, '.trae', 'extensions'));
  return [...new Set(roots)];
}

function findServerDir(fromExtensionDir) {
  const explicit = process.env.JDTLS_HOME || process.env.REDHAT_JAVA_HOME;
  if (explicit) {
    const server = firstExisting([
      explicit,
      path.join(explicit, 'server'),
    ]);
    if (server) return server;
  }

  // 桥接上报的 redhat.java 扩展根目录最准确：与当前运行的 IDE 完全一致
  if (fromExtensionDir) {
    const server = path.join(fromExtensionDir, 'server');
    if (fs.existsSync(path.join(server, 'plugins'))) return server;
  }

  const candidates = [];
  for (const extRoot of extensionSearchRoots()) {
    try {
      for (const name of fs.readdirSync(extRoot)) {
        if (/^redhat\.java-/.test(name)) candidates.push(path.join(extRoot, name, 'server'));
      }
    } catch (_) { /* ignore */ }
  }
  candidates.sort().reverse();

  return firstExisting(candidates, (p) => fs.existsSync(path.join(p, 'plugins')));
}

function findLauncher(serverDir) {
  const plugins = path.join(serverDir, 'plugins');
  const files = fs.readdirSync(plugins).filter((n) => /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(n));
  if (!files.length) throw new Error('找不到 org.eclipse.equinox.launcher jar: ' + plugins);
  files.sort();
  return path.join(plugins, files[files.length - 1]);
}

function configDir(serverDir) {
  const platform = process.platform;
  const name = platform === 'win32' ? 'config_win'
    : platform === 'darwin' ? 'config_mac' : 'config_linux';
  const p = path.join(serverDir, name);
  if (!fs.existsSync(p)) throw new Error('找不到 JDT LS 配置目录: ' + p);
  return p;
}

function findJarUnder(dir, depth) {
  if (depth < 0) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
  const jars = entries.filter((e) => e.isFile() && /^lombok.*\.jar$/i.test(e.name));
  if (jars.length) return path.join(dir, jars[0].name);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = findJarUnder(path.join(dir, e.name), depth - 1);
    if (found) return found;
  }
  return null;
}

// Lombok 支持：显式环境变量 → redhat.java 自带 agent → Lombok Annotations Support 扩展
function findLombokJar(serverDir) {
  const explicit = process.env.LOMBOK_JAR;
  if (explicit && fs.existsSync(explicit)) {
    return { jar: explicit, source: 'env: LOMBOK_JAR' };
  }
  if (serverDir) {
    const bundled = findJarUnder(path.join(path.dirname(serverDir), 'lombok'), 1);
    if (bundled) return { jar: bundled, source: 'redhat.java bundled lombok' };
  }
  for (const root of extensionSearchRoots()) {
    let names;
    try { names = fs.readdirSync(root); } catch (_) { continue; }
    for (const name of names) {
      if (!/lombok/i.test(name)) continue;
      const jar = findJarUnder(path.join(root, name), 2);
      if (jar) return { jar, source: 'extension: ' + name };
    }
  }
  return null;
}

function prepareConfig(serverDir, dataDir) {
  const src = configDir(serverDir);
  const dst = path.join(dataDir, 'config-' + process.platform);
  if (!fs.existsSync(dst)) {
    fs.cpSync(src, dst, { recursive: true });
  }
  return dst;
}

function buildArgs(serverDir, dataDir, options) {
  const launcher = findLauncher(serverDir);
  const config = prepareConfig(serverDir, dataDir);
  const args = [
    '-Declipse.application=org.eclipse.jdt.ls.core.id1',
    '-Dosgi.bundles.defaultStartLevel=4',
    '-Declipse.product=org.eclipse.jdt.ls.core.product',
    '-Dlog.level=ERROR',
    // redhat.java 以系统属性形式控制元数据位置；必须在 -jar 之前
    '-Djava.import.generatesMetadataFilesAtProjectRoot=' + (options && options.metadataAtProjectRoot ? 'true' : 'false'),
    '-Xmx2G',
    '--add-modules=ALL-SYSTEM',
    '--add-opens', 'java.base/java.util=ALL-UNNAMED',
    '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
    '--add-opens', 'java.base/java.io=ALL-UNNAMED',
    '--add-opens', 'java.base/java.nio=ALL-UNNAMED',
    '--add-opens', 'java.base/sun.nio.ch=ALL-UNNAMED',
    '--add-opens', 'java.base/java.lang.reflect=ALL-UNNAMED',
    '--add-opens', 'java.base/java.text=ALL-UNNAMED',
    '--add-opens', 'java.base/java.util.concurrent=ALL-UNNAMED',
    '--add-opens', 'java.base/java.util.concurrent.locks=ALL-UNNAMED',
    '--add-opens', 'java.base/java.util.regex=ALL-UNNAMED',
    '--add-opens', 'java.base/java.net=ALL-UNNAMED',
    '--add-opens', 'java.base/java.math=ALL-UNNAMED',
    '--add-opens', 'java.base/jdk.internal.misc=ALL-UNNAMED',
    '--add-opens', 'java.base/java.lang.invoke=ALL-UNNAMED',
    '--add-opens', 'java.base/java.util.stream=ALL-UNNAMED',
    '--add-opens', 'java.base/java.security=ALL-UNNAMED',
    '--add-opens', 'java.base/javax.crypto=ALL-UNNAMED',
    '--add-opens', 'java.management/java.lang.management=ALL-UNNAMED',
    '--add-opens', 'java.management/sun.management=ALL-UNNAMED',
    '--add-opens', 'java.base/java.util.concurrent.atomic=ALL-UNNAMED',
    '--add-opens', 'java.base/java.lang.annotation=ALL-UNNAMED',
  ];
  const lombok = findLombokJar(serverDir);
  if (lombok) args.push('-javaagent:' + lombok.jar);
  args.push(
    '-jar', launcher,
    '-configuration', config,
    '-data', dataDir,
  );
  return args;
}

function findJava(serverDir) {
  // redhat.java 扩展自带 JRE（新版本 JDT LS 需要 Java 21+）
  const extDir = path.dirname(serverDir);
  const jreRoot = path.join(extDir, 'jre');
  try {
    const dirs = fs.readdirSync(jreRoot).sort().reverse();
    for (const d of dirs) {
      const exe = path.join(jreRoot, d, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
      if (fs.existsSync(exe)) return exe;
    }
  } catch (_) { /* ignore */ }
  if (process.env.JAVA_HOME) {
    const exe = path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (fs.existsSync(exe)) return exe;
  }
  return 'java';
}

module.exports = { findServerDir, buildArgs, findJava, findLombokJar };