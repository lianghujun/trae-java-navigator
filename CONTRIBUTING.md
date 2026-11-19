# 贡献指南

感谢你关注 Trae Java Navigator。本仓库包含 MCP 插件（`server/`、`skills/`）与配套桥接扩展（独立仓库 `trae-java-bridge`）。

## 开发环境

- Node.js 18+（仅用标准库，无运行时依赖）
- Java 21（JDT LS 1.58 需要；桥接扩展自带 JRE 时以 IDE 为准）
- Trae CN / Trae（插件与 Skill 注册），或任意支持 MCP 的客户端（仅 MCP 部分）
- IDE 侧需安装 `redhat.java`

## 本地运行

```bash
# 安装插件（含随包桥接扩展，需完全重启 Trae 生效）
node install.mjs

# 仅调试 MCP（stdio JSON-RPC）
node server/mcp-server.js
```

桥接扩展单独开发时，在 `trae-java-bridge-extension` 仓库执行 `npm run package:vsix`，再 `node install.mjs --vsix dist/trae-java-bridge.vsix`。

## 基准测试

测试代码在 `bench/`，`install.mjs` 已将其排除，不会随插件发布。方法论、数量级轴、场景矩阵与上下文偏差控制见 [docs/bench.md](./docs/bench.md)。

```bash
# 生成 10/100/1000 文件规模的合成工程
node bench/generate-fixtures.mjs --out ./bench-out --scales 10,100,1000

# rg 基线（不需要 IDE）
node bench/bench.mjs --fixtures ./bench-out --modes rg --repeats 10

# rg + MCP（独立 JDT LS，每个 fixture 冷启动）
node bench/bench.mjs --fixtures ./bench-out --modes rg,mcp --repeats 10

# rg + 扩展桥接（IDE 需已打开该工程）
node bench/bench.mjs --fixtures ./bench-out --modes rg,bridge --bridge-workspace /path/to/java-project
```

结果写入 `bench-out/out/report.md` 与 `result.json`。`--scales` 同时决定生成哪些 fixture；`bench.mjs --scales` 只做过滤。基准结果只作为回归参考，不要提交 `bench-out/`。

## 代码约定

- `server/` 使用 CommonJS；ESM 仅用于安装脚本与 `bench/`
- 不引入运行时第三方依赖；日志写 stderr（MCP 的 stdout 只承载 JSON-RPC）
- 行列号统一 1-based；`file` 支持绝对路径或相对工作区路径
- 跨平台：Windows / macOS / Linux，路径处理用 `node:path`
- 注释与文档以中文为主，标识符用英文

## 修改工具描述或 Skill

工具描述、`initialize.instructions` 与 `skills/java-navigate/SKILL.md` 都会影响 AI 的调用选择。改动时请：

1. 保持“何时用 / 何时改用 Grep/Read”的边界表述，避免绝对化指令
2. 跑一次 `bench` 回归，确认耗时与结果数量没有退化
3. 若参数变化，同步更新 `README.md` / `README.en.md` 的工具表与 Skill 说明

## 提交 Pull Request

- 一个 PR 解决一个问题，避免混入无关格式化
- 说明变更动机、影响面与验证方式（命令或 `java_status` 输出）
- 不提交密钥、个人路径、`bench-out/`、临时索引缓存
- 涉及桥接协议的改动，需同时验证 `source=ide-bridge` 与 `source=standalone-jdtls` 两条路径

## 报告问题

提交 Issue 时请附上：

- `java_status` 返回（含 `source` 与 `bridgeError`）
- 复现命令或 MCP 调用参数
- 操作系统、IDE 版本、redhat.java 版本

安全问题请勿公开提交，见 [SECURITY.md](./SECURITY.md)。