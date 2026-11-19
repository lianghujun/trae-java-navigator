#!/usr/bin/env node
'use strict';

// 生成规模可控的 Java 测试工程，用于对比 MCP 语义查询与 ripgrep 的耗时/输出体积/精度。
// 用法：node bench/generate-fixtures.mjs --out <dir> --scales 10,100,1000

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: path.join(os.tmpdir(), 'trae-java-bench') },
    scales: { type: 'string', default: '10,100,1000' },
  },
});

const OUT = path.resolve(values.out);
const SCALES = String(values.scales)
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n >= 4)
  .map((n) => Math.round(n));

const FILE_LINES = [100, 1000, 10000];

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function pom(artifactId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>bench</groupId>
  <artifactId>${artifactId}</artifactId>
  <version>1.0.0</version>
  <properties>
    <maven.compiler.source>17</maven.compiler.source>
    <maven.compiler.target>17</maven.compiler.target>
  </properties>
</project>
`;
}

const TARGET = `package bench.fx;

public class BenchTarget {
    public static void targetMethod() { }
}
`;

function caller(k) {
  return `package bench.fx;

public class Caller${k} {
    void use() { BenchTarget.targetMethod(); }
}
`;
}

// 只在注释里出现符号：rg 会命中，语义工具不会，用于测精度
function filler(k) {
  return `package bench.fx;

// noise: BenchTarget is mentioned only in this comment
public class Filler${k} { }
`;
}

function bad(k) {
  return `package bench.fx;

public class Bad${k} {
    MissingType${k} field;
}
`;
}

function bigFile(lines) {
  const methods = [];
  const count = Math.max(8, lines - 4);
  for (let i = 0; i < count; i++) methods.push(`    void m${i}() { }`);
  const needleIdx = Math.floor(count / 2);
  methods[needleIdx] = '    void needleMethod() { }';
  const body = `package bench.fx;\n\npublic class BigFile {\n${methods.join('\n')}\n}\n`;
  return { body, needleLine: 4 + needleIdx };
}

const manifest = [];

function addFixture(entry) {
  manifest.push({ ...entry, root: path.join(OUT, entry.id) });
}

function generateRepo(id, scale, callers) {
  callers = Math.max(1, Math.min(callers, scale - 2));
  const fillers = Math.max(0, scale - 1 - callers);
  addFixture({
    id,
    kind: 'repo',
    scale,
    files: scale,
    callers,
    fillers,
    rgHitLines: scale,
    trueCodeLines: callers + 1,
    query: 'BenchTarget',
    targetFile: 'src/main/java/bench/fx/BenchTarget.java',
    targetLine: 3,
    targetColumn: 14,
    callerFile: 'src/main/java/bench/fx/Caller0.java',
    callerLine: 3,
    callerColumn: 18,
    expectedSymbols: 1,
    expectedRefs: callers + 1,
    expectedErrors: 0,
  });
  const root = path.join(OUT, id);
  fs.rmSync(root, { recursive: true, force: true });
  write(root, 'pom.xml', pom(id));
  write(root, 'src/main/java/bench/fx/BenchTarget.java', TARGET);
  for (let i = 0; i < callers; i++) {
    write(root, `src/main/java/bench/fx/Caller${i}.java`, caller(i));
  }
  for (let i = 0; i < fillers; i++) {
    write(root, `src/main/java/bench/fx/Filler${i}.java`, filler(i));
  }
}

function generateDiag(id, errors) {
  addFixture({
    id,
    kind: 'diag',
    scale: errors,
    files: errors + 1,
    query: 'BenchTarget',
    targetFile: 'src/main/java/bench/fx/BenchTarget.java',
    targetLine: 3,
    targetColumn: 14,
    callerFile: 'src/main/java/bench/fx/BenchTarget.java',
    callerLine: 3,
    callerColumn: 14,
    expectedSymbols: 1,
    expectedRefs: 0,
    expectedErrors: errors,
  });
  const root = path.join(OUT, id);
  fs.rmSync(root, { recursive: true, force: true });
  write(root, 'pom.xml', pom(id));
  write(root, 'src/main/java/bench/fx/BenchTarget.java', TARGET);
  for (let i = 0; i < errors; i++) {
    write(root, `src/main/java/bench/fx/Bad${i}.java`, bad(i));
  }
}

function generateFile(lines) {
  const id = `file-${lines}`;
  const { body, needleLine } = bigFile(lines);
  addFixture({
    id,
    kind: 'file',
    scale: lines,
    files: 1,
    query: 'BigFile',
    bigFile: 'src/main/java/bench/fx/BigFile.java',
    needleLine,
    expectedSymbols: 1,
    expectedErrors: 0,
  });
  const root = path.join(OUT, id);
  fs.rmSync(root, { recursive: true, force: true });
  write(root, 'pom.xml', pom(id));
  write(root, 'src/main/java/bench/fx/BigFile.java', body);
}

fs.mkdirSync(OUT, { recursive: true });
const seen = new Set();
for (const scale of SCALES) {
  if (seen.has(scale)) continue;
  seen.add(scale);
  generateRepo(`repo-${scale}-hits-${Math.max(1, Math.round(scale * 0.1))}`, scale, Math.max(1, Math.round(scale * 0.1)));
  generateDiag(`diag-${scale}`, scale);
}
// 固定规模下分离“仓库大小”和“符号热度”两个轴
generateRepo('repo-1000-unique', 1000, 1);
generateRepo('repo-1000-hot', 1000, 900);
for (const lines of FILE_LINES) generateFile(lines);

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(`Generated ${manifest.length} fixtures under ${OUT}`);
for (const f of manifest) console.log(`  ${f.id}  files=${f.files}`);