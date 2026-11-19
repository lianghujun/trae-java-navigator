'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

function readJsonc(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
  } catch (_) {
    return null;
  }
}

function userSettingsCandidates() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const names = ['Trae CN', 'Trae', 'Code', 'Cursor', 'VSCodium'];
  const dirs = [];
  if (process.platform === 'win32') {
    for (const n of names) dirs.push(path.join(appData, n, 'User'));
  } else if (process.platform === 'darwin') {
    for (const n of names) dirs.push(path.join(home, 'Library', 'Application Support', n, 'User'));
  } else {
    for (const n of names) dirs.push(path.join(home, '.config', n, 'User'));
  }
  if (process.env.TRAE_USER_SETTINGS) dirs.unshift(process.env.TRAE_USER_SETTINGS);
  return dirs;
}

function loadJavaSettings(workspaceRoot) {
  let user = {};
  for (const dir of userSettingsCandidates()) {
    const parsed = readJsonc(path.join(dir, 'settings.json'));
    if (parsed) {
      user = parsed;
      if (parsed['java.configuration.runtimes'] !== undefined) break;
    }
  }
  const workspace = readJsonc(path.join(workspaceRoot || process.cwd(), '.vscode', 'settings.json')) || {};
  const pick = (key) => (workspace[key] !== undefined ? workspace[key] : user[key]);
  const runtimes = pick('java.configuration.runtimes');
  return {
    runtimes: Array.isArray(runtimes) ? runtimes : [],
    mavenEnabled: pick('java.import.maven.enabled') !== false,
    metadataAtProjectRoot: pick('java.import.generatesMetadataFilesAtProjectRoot') === true,
    javaHome: pick('java.jdt.ls.java.home') || null,
    sourceLevel: pick('java.project.source.level') || null,
  };
}

function detectProjectJavaVersion(workspaceRoot) {
  try {
    const pom = fs.readFileSync(path.join(workspaceRoot, 'pom.xml'), 'utf8');
    const pick = (re) => {
      const m = re.exec(pom);
      return m ? m[1].trim() : null;
    };
    return pick(/<java\.version>\s*([^<]+)<\/java\.version>/)
      || pick(/<maven\.compiler\.release>\s*([^<]+)<\/maven\.compiler\.release>/)
      || pick(/<maven\.compiler\.source>\s*([^<]+)<\/maven\.compiler\.source>/)
      || pick(/<source>\s*([^<]+)<\/source>/);
  } catch (_) {
    return null;
  }
}

function javaSettingsForSection(javaSettings, section) {
  if (!section || !section.startsWith('java')) return {};
  return {
    configuration: { runtimes: javaSettings.runtimes },
    import: {
      maven: { enabled: javaSettings.mavenEnabled },
      generatesMetadataFilesAtProjectRoot: javaSettings.metadataAtProjectRoot === true,
    },
    project: javaSettings.sourceLevel ? { source: { level: javaSettings.sourceLevel } } : {},
  };
}

module.exports = { loadJavaSettings, detectProjectJavaVersion, javaSettingsForSection };