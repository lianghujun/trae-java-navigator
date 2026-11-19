# 基准测试方法与场景矩阵

本文说明 `bench/` 的测试口径：如何对比 MCP 工具、IDE 桥接与 ripgrep，如何按数量级分层，以及如何避免 AI 受上下文影响导致的偏差。

## 1. 要回答的问题

1. **触发率**：在应该用语义查询的场景里，AI 首个检索动作是不是 MCP 工具？
2. **误用率**：在纯文本/非 Java 场景里，AI 是否错误地调用了 MCP？
3. **速度**：不同数量级下，各端点 p50/p95 与 rg 的差距。
4. **效率**：完成任务所需的步数、工具调用数、token 与正确率。

只比较单次调用耗时不够：wall time 被模型思考时间主导，必须同时看步数与 token；触发率则只能在真实模型会话里测，MCP 日志证明不了“为什么没用”。

## 2. 基线与数据源

| 代号 | 方式 | 说明 |
|---|---|---|
| G1 | `rg -l` | 只列命中文件，rg 最省输出的形态 |
| G2 | `rg -n --no-heading` | 输出 `文件:行号:内容`，接近 agent 的 Grep 输出 |
| G3 | `rg -l` + 逐文件读取 | 模拟 agent 核实命中，成本最高 |
| R1 | `Read` | 已知文件与位置时最直接的路径 |
| M1 | 桥接 HTTP | IDE 已索引的热态，纯 HTTP 开销 |
| M2 | 独立 JDT LS | 冷启动与热态分开记录，初始化不计入查询耗时 |
| M3 | MCP 端到端 | 含 MCP 进程与 stdio 协议开销 |

公平性说明：

- rg 每次是新进程；桥接是常驻服务；因此 M1 与 M3 都要报，不能只挑对自己有利的一项。
- IDE 内置的 Grep 工具可能使用常驻 ripgrep，速度与 CLI 不同；需要用相同 flags 的 wrapper 或会话日志校准。
- 合成工程与真实工程都要测：前者提供 ground truth，后者提供真实磁盘/项目布局。

## 3. 数量级轴

| 轴 | 档位 | 观察点 |
|---|---|---|
| 仓库规模 | 10 / 100 / 1k / 10k 个 Java 文件 | 搜索成本随文件数增长 |
| 符号热度 | 1 / 10 / 100 / 10k 次出现 | 唯一符号 vs `String` 这类泛化查询 |
| 单文件行数 | 100 / 1k / 10k 行 | 已知文件内的 Read/Grep 成本 |
| 引用数 | 1 / 10 / 100 / 1k | references 的响应体积与截断行为 |
| 诊断数 | 0 / 10 / 100 / 1k errors | diagnostics 的过滤与 limit 行为 |

`bench/generate-fixtures.mjs` 生成可控 fixture：`repo-*`（仓库×热度）、`repo-1000-unique` / `repo-1000-hot`（固定规模分离热度）、`file-*`（单文件行数）、`diag-*`（错误数）。填充文件只在注释里出现符号，用于计算 rg 的假阳性比例。

## 4. 场景矩阵

| 任务类型 | 数量级 | 期望 | 对比 |
|---|---|---|---|
| 不知道符号在哪个文件 | 仓库 100/1k/10k × 热度 1/10/100 | 先 `java_search {query}` | G1/G2/M1/M3 |
| 已知文件找方法 | 单文件 100/1k/10k 行 | `java_search {file,name}` | G2/R1/M3 |
| 从调用点跳定义 | 仓库 1k/10k | `java_navigate definition` | G2+G3/M3 |
| 改动前盘点引用 | 引用数 1/10/100/1k | `java_navigate references`（`limit` 默认 200；`count`/`returned`/`truncated` 区分总数与截断） | G1/G2/G3/M3 |
| 高热度引用（>500） | 1k 引用 | 先限制 `limit`，或改用 rg 后逐条核实；MCP 可能慢于 rg | G2/G3/M3 |
| 编译错误定位 | 诊断数 0/10/100/1k | `java_diagnostics` | G2/Maven |
| 负控：字符串常量/注释 | 任意 | **不应**调用 MCP | G2/R1 |
| 负控：YAML/pom 配置 | 任意 | **不应**调用 MCP | G2/R1 |
| 负控：`target/` 生成代码 | 任意 | **不应**调用 MCP | G2/R1 |
| 混合：冷启动 + 小任务 | 10 文件 | 允许先 Read，同时 `java_status {warmup:true}` | R1/M2/M3 |

每个正控场景准备 3 种中英文改写，测描述的鲁棒性；负控用于计算误用率，不参与触发率分母。

## 5. 控制 AI 的上下文偏差

AI 的选择会被上下文显著影响，实验必须固定或显式变化以下因素：

- **会话**：每个 run 全新会话，禁用跨会话记忆，任务提示中不出现工具名或 grep 字样。
- **描述暴露层级**：
  - A 旧描述（基线）
  - B 仅新工具描述
  - C B + `initialize.instructions`
  - D C + Skill `description`
  - E D + Skill 正文加载
- **顺序**：场景与条件顺序随机化（或拉丁方），避免学习效应。
- **锚定**：统计**首个检索动作**，并单独记录“一次 Grep 命中后是否继续 Grep”。
- **文案反诱导**：增加“去掉所有 Grep/Read 字样”的消融版本，确认边界说明没有反向激活文本搜索。
- **模型变量**：固定模型版本、温度与最大步数；不混用不同客户端。
- **环境**：桥接冷/热、JDT 索引冷/热分开，避免把索引时间算成工具收益。
- **重复**：每格 ≥10–20 次，报 p50/p95 与置信区间。

## 6. 指标与统计

| 指标 | 定义 |
|---|---|
| 触发率 | 首个检索动作为 MCP 的正控会话数 / 正控会话总数 |
| 误用率 | 调用了 MCP 的负控会话数 / 负控会话总数 |
| 回退率 | MCP 报错或 0 条后改用 Grep/Read 的会话占比 |
| 任务效率 | 步数、工具调用数、token、任务成功率 |
| 提升率 | `(baseline − scheme) / baseline`，同场景配对比较 |
| 速度 | 各端点 p50/p95；M2 另报冷启动耗时 |
| 响应体积 | 单次返回 JSON 的字节数，直接影响上下文成本 |
| 截断率 | references 中 `truncated=true` 的占比与 `returned/count` |

- 比例指标用 Wilson 95% CI；条件间用配对 McNemar 检验。
- 延迟用 p50/p95，不用平均值；提升率用配对差值 + bootstrap CI。
- Grep 侧同时报 `precision = 真实代码命中 / 总命中`，把注释、字符串、同名测试的复核成本显性化。
- 分开统计“是否调用”和“调用后是否成功”，避免把工具失败混进触发率。

## 7. 埋点与数据采集（方案，尚未接入）

当前仓库只有 `bench/` 的脚本级测量；MCP 与扩展的 JSONL 埋点尚未实现，本节是后续接入方案。触发率需要三处数据按 `runId` 关联：

- MCP：`tools/call` 前后写 JSONL（默认关闭，`JAVA_NAV_USAGE_LOG` 开启），字段建议：
  ```json
  {"ts":"...","runId":"...","sessionId":"...","tool":"java_search","args":{"query":"X"},
   "source":"ide-bridge","latencyMs":37,"resultCount":1,"error":null}
  ```
- 扩展：每个端点记录 `path`、`latencyMs`、`status`、`resultCount`（同样默认关闭）。
- 会话：负控里的 Grep/Read 不经过 MCP，必须从客户端会话记录解析首动作与工具序列。

只记录元数据；不要记录桥接 token。查询参数如可能含业务标识，截断或哈希。

## 8. 实测数据（2026-11-19，本机）

环境：Windows；rg 由 WinGet 安装；合成工程由 `generate-fixtures.mjs` 生成在临时目录；真实工程为约 3k 个 Java 文件 / 约 8MB 的业务工程（IDE 桥接热态，不记录具体路径与工程名）。本节数据为 `--repeats 2` 的验证跑，用于确认量级与方向；正式结论请用 10–20 次重复并看 p95。

### 8.1 冷启动与仓库规模（独立 JDT LS）

| fixture | 文件数 | JDT 就绪 | rg:lines p50 | mcp:search p50 | 加速 |
|---|---:|---:|---:|---:|---:|
| repo-10-hits-1 | 10 | 5.4s | 46.8ms | 1.9ms | 24x |
| repo-100-hits-10 | 100 | 5.6s | 50.9ms | 2.6ms | 19x |
| repo-1000-hits-100 | 1000 | 5.9s | 124.8ms | 3.3ms | 38x |
| repo-1000-unique | 1000 | 6.1s | 143.3ms | 4.9ms | 30x |
| repo-1000-hot | 1000 | 6.1s | 136.1ms | 3.7ms | 37x |

冷启动 5.4–6.2s，几乎不随文件数变化，属环境成本（JDT 启动 + Maven 导入），必须单列；上表的查询耗时均在就绪后测量。

### 8.2 端点对比（1000 文件，100 个调用方）

| 场景 | p50 | 输出字节 | 结果 |
|---|---:|---:|---|
| rg:list | 118.6ms | 106,782 | 1000 命中 |
| rg:lines | 124.8ms | 163,853 | 1000 命中 |
| rg:verify | 162.3ms | 207,650 | 读取 1000 个命中文件 |
| mcp:search | 3.3ms | 536 | 1 个类 |
| mcp:fileSymbol | 4.7ms | 625 | 1 个方法 |
| mcp:definition | 4.9ms | 410 | 1 个位置 |
| mcp:references（101 条） | 67.5ms | 30,418 | returned=100，truncated=true |
| mcp:references（901 条，hot） | 370.3ms | 29,610 | returned=100，truncated=true |

即使 MCP 更慢，返回体积仍小一个数量级（约 30KB vs 150KB），上下文成本更低。

### 8.3 引用规模的交叉点

| 引用总数 | MCP p50 | rg:lines p50 | 比值 | 说明 |
|---:|---:|---:|---:|---|
| 2 | 13.3ms | 143.3ms | 10.7x | repo-1000-unique |
| 11 | 19.7ms | 50.9ms | 2.6x | repo-100 |
| 101 | 67.5ms | 124.8ms | 1.9x | 截断到 100 |
| 901 | 370.3ms | 136.1ms | **0.37x** | hot，MCP 反而慢 |

结论：引用数在数百以内，MCP 更快且输出更小；接近千条时 JDT 的语义计算成本超过 rg，应先限制 `limit`，或改用 rg 再逐条核实。

### 8.4 rg 的假阳性成本（合成工程 ground truth）

| fixture | rg 命中行 | 真实代码行 | precision |
|---|---:|---:|---:|
| repo-10-hits-1 | 10 | 2 | 20% |
| repo-100-hits-10 | 100 | 11 | 11% |
| repo-1000-hits-100 | 1000 | 101 | 10.1% |
| repo-1000-unique | 1000 | 2 | 0.2% |
| repo-1000-hot | 1000 | 901 | 90.1% |

唯一符号时，rg 把注释里的提及全部算作命中，精度接近 0；热符号时则接近 90%。这直接对应“人工/模型复核成本”。

### 8.5 真实工程桥接（约 3k 文件，31 条引用）

| 场景 | p50 | 输出字节 | 结果 |
|---|---:|---:|---|
| bridge:search | 100.2ms | 274 | items=1 |
| bridge:definition | 35.7ms | 176 | items=1 |
| bridge:references | 668.8ms | 5,975 | refs=31 |
| bridge:diagnostics | 7.4ms | 4,951 | errors=15 |
| rg:list | 1485.4ms | 1,679 | hits=14 |
| rg:lines | 1485.1ms | 6,609 | hits=33 |

同一符号下：definition 约 42x、search 约 15x、references 约 2.2x、diagnostics 约 200x。与早期直接调用桥接的量级一致（热态 `/symbols` 约 140ms、`/definition` 约 18ms、`/references` 约 900ms、`/diagnostics` 约 11ms）。

### 8.6 diagnostics 的规模限制

`diag-1000` 期望 1000 条 error，实际只返回 286 条：独立模式的 `workspace/diagnostic` 不可用时会回退到已推送诊断，覆盖面受 JDT 发布策略限制；桥接模式直接读编辑器诊断（`getDiagnostics()`），但同样只覆盖 IDE 已知文件。诊断规模测试必须区分“桥接全量”和“独立回退”。

### 8.7 结论

- definition / diagnostics：两个数量级优势，且不随仓库规模明显退化。
- workspace symbol：一个数量级以上；泛化查询（如 `String`）会让 MCP 变慢，需按符号热度分层看。
- references：低引用数胜在耗时与精度；高引用数（近千）耗时反超 rg，但输出体积仍小得多。
- 已知文件读代码：`Read` 仍最便宜，工具不应插手。

## 9. 复现命令

```bash
# 生成合成工程（--scales 决定 repo/diag 档位；file-* 固定生成 100/1000/10000 行）
node bench/generate-fixtures.mjs --scales 10,100,1000

# rg 基线 + 独立 JDT LS（每个 fixture 冷启动，就绪时间单独打印）
node bench/bench.mjs --modes rg,mcp --repeats 10

# 追加真实 IDE 工程桥接对比（需 IDE 已打开该工程）
node bench/bench.mjs --modes rg,bridge --bridge-workspace <你的Java工程根目录> --repeats 10
```

- 结果写入 `<fixtures>/out/report.md` 与 `result.json`，默认 fixtures 目录是 `%TEMP%\trae-java-bench`。
- `bench.mjs --scales` 只过滤已生成的 fixture；`file-*` 的 scale 是行数，跑 10k 行文件需加 `--scales 10000`。
- 每次运行自动使用全新的 JDT 缓存目录；手动复现独立 JDT 场景时，先删除 `%TEMP%\trae-java-navigator` 下对应的 `jdt-ws-*`。
- JDT LS 需要写入 Maven 本地仓库，建议在普通终端运行，不要使用受限沙箱。

## 10. 已知限制

- rg 版本、flags、磁盘与杀毒软件会显著影响结果，跨机器只能看相对比值。本轮 rg 在约 3k 个文件上约 1.5s，属该机器环境值。
- 合成 fixture 的 ground truth 确定性好，但布局比真实工程简单；`repo-10000`、`file-10000` 尚未纳入本轮数据。
- 桥接模式要求 IDE 已打开目标工程；未打开时只能测独立 JDT LS。
- 桥接的 references `limit` 需要新版扩展；旧版会忽略参数（MCP 侧仍会本地截断并返回 `returned/truncated`）。
- JDT LS 冷启动 5.4–6.2s，首次 Maven 依赖解析可能更久，必须与查询耗时分开统计。
- 复用 JDT 工作区缓存会锁死一次失败的 Maven 导入（builder 报 `AccessDeniedException`），表现为所有查询持续 0 条；bench 已改为每次全新缓存。
- `diag-1000` 只得到 286/1000 条错误：诊断规模测试必须区分桥接全量与独立回退。
- 触发率无法完全自动化：没有 headless agent 时采用“场景清单 + 全新会话 + 日志汇总”的半自动流程；MCP/扩展 JSONL 埋点尚未实现，当前只能采到工具层数据。