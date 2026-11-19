---
name: java-navigate
description: "Use when answering: where is a Java class/method/field, which file declares it, who calls it, where does this line jump to, what is the signature, why does compilation fail, how many compile errors exist and in which files. Returns exact file:line:column for Java symbols. Prefer it when the declaring file is unknown or exact semantics matter (same-name/overload, real references). Read/Grep are cheaper for known files/positions, plain text, non-Java files, and generated/out-of-project sources. Not for renaming/refactoring, call/type/implementation hierarchies, or final build verification."
description_zh: "当需要回答「某类/方法/字段在哪、谁调用了它、这行跳到哪、签名是什么、为什么编译报错、一共有多少错误、分布在哪些文件」时使用，返回精确的 file:line:column 与错误清单。按耗时与可信度选择：不知道声明文件、需要区分同名/重载/真实引用时，工具通常比 Grep 快 1–2 个数量级；已知文件位置读代码、纯文本、非 Java 文件、生成或工程外源码则用 Read/Grep。不覆盖重命名/重构、调用/类型/实现层次与最终构建验证。"
description_en: "Use when answering: where is a Java class/method/field, which file declares it, who calls it, where does this line jump to, what is the signature, why does compilation fail, how many compile errors exist and in which files. Returns exact file:line:column for Java symbols. Prefer it when the declaring file is unknown or exact semantics matter (same-name/overload, real references). Read/Grep are cheaper for known files/positions, plain text, non-Java files, and generated/out-of-project sources. Not for renaming/refactoring, call/type/implementation hierarchies, or final build verification."
version: "0.1.2"
---

# Java Navigator

4 个只读工具，查询 IDE 里的 Java 编译/索引引擎（Eclipse JDT 语言服务，简称 JDT LS）。

坐标约定：`line` 与 `column` 都**从 1 开始**，列号是编辑器里的字符偏移（Tab 算 1 个字符，不是屏幕视觉列）；返回结果同样从 1 开始。例如 `line:42, column:18` = 第 42 行第 18 个字符。

`file` 可以传绝对路径，也可以传相对 Java 工程根目录的路径。

## 场景 → 调用（先查这张表）

| 你要回答的问题 | 调用 | 关键点 |
|---|---|---|
| 某类在哪？在哪个包？ | `java_search {query:"类名", limit:10}` | 用完整类名或前缀；结果里看 `kind=Class`。不要用 `String`/`get` 这类泛化词，会让查询退化到秒级 |
| A 类里的 b 方法在哪？ | `java_search {class:"A", name:"b", kind:"Method"}` | 不需要先知道文件 |
| 某文件里有哪些方法/字段？ | `java_search {file:"...", kind:"Method", limit:100}` | 大文件先按 `kind` 收窄 |
| 第 N 行这个调用跳到哪？ | `java_navigate {action:"definition", file, line, column}` | 位置必须落在**标识符首字符**；落在包前缀/空白/标点会返回 0 条 |
| 谁调用了它？被哪些文件引用？ | 先取声明位置，再 `java_navigate {action:"references", file, line, column, limit:200}` | 看 `count` 与 `truncated`；>500 条先截断或改用 Grep |
| 这个方法的签名/参数是什么？ | `java_navigate {action:"hover", file, line, column}` | 目标在依赖 jar 内时尤其有用 |
| 为什么编译报错？错误有多少、分布在哪些文件？ | `java_diagnostics {severity:"error", limit:100}` | 返回 `total` 以及每条 `file/line/column/severity/code/message`；可按 `file` 聚合出“哪些文件、各多少条” |
| 这个文件有哪些错误/警告？ | `java_diagnostics {file:"...", severity:"all", limit:200}` | 单文件默认查全部级别；工作区默认只查 error |
| 工具能用吗？索引好了吗？ | `java_status {}` / `{warmup:true}` | 首次使用、0 条或超时再查，不必每次 |

## 调用模板（可直接照抄，替换文件名与行列）

```json
{"name":"java_search","arguments":{"query":"OrderService","limit":10}}
```
```json
{"name":"java_search","arguments":{"class":"OrderService","name":"createOrder","kind":"Method"}}
```
```json
{"name":"java_search","arguments":{"file":"src/main/java/com/example/OrderService.java","name":"createOrder","kind":"Method","limit":20}}
```
```json
{"name":"java_navigate","arguments":{"action":"definition","file":"src/main/java/com/example/OrderService.java","line":88,"column":17}}
```
```json
{"name":"java_navigate","arguments":{"action":"references","file":"src/main/java/com/example/OrderService.java","line":42,"column":18,"limit":200}}
```
```json
{"name":"java_diagnostics","arguments":{"severity":"error","limit":100}}
```
```json
{"name":"java_status","arguments":{"warmup":true}}
```

获取 references 的起点：先用 `java_search {file, name}` 或 `java_search {query}` 拿到声明的 `file/line/column`（结果中的 `column` 就是标识符首字符），再传给 `java_navigate`。

## 返回什么（字段含义）

- `java_search` → `count`、`items[{name,kind,container,file,line,column,endLine,endColumn}]`、`summary`（每行 `file:line:column kind container#name`）。
- `java_navigate definition` → `count`、`items`（额外带 `text` 源码行）、`summary`。
- `java_navigate references` → `count`（总数）、`returned`（实际条数）、`truncated`、`items[{file,line,column,endLine,endColumn}]`、`summary`。
- `java_navigate hover` → `text`（签名/文档）与 `range`。
- `java_diagnostics` → `total`；文件模式有 `file`，工作区模式 `items[{file,line,column,severity,message,source,code}]` 按文件排序。
- `java_status` → `source`（`ide-bridge` = 复用 IDE 索引；`standalone-jdtls` = MCP 自己启动的 JDT LS）、`status`、`ready`、`bridgeError`、`projectJavaVersion`、`lombok` 等。

## 参数规则

- `line` / `column`：从 1 开始，列号按字符偏移计算（Tab 算 1 个字符），不是屏幕视觉列；`column` 必须指向标识符第一个字符。definition/references 返回 0 条时，优先检查是否指到了包名前缀或空白。
- `kind`：`Class` / `Interface` / `Enum` / `Method` / `Field` / `Constructor`；Java record 归为 `Class`。`kind` 只作用于 `file` 与 `class` 定位；工作区 `query` 路径不做 kind 过滤，需在结果里自行看 `kind`。
- `limit`：`java_search` 工作区默认 50、文件默认 200；`references` 默认 200，`limit:0` 返回全部。响应里 `count` 是总数，`returned` 是实际条数，`truncated` 表示是否截断。
- `includeDeclaration`：references 默认包含声明；桥接模式下该参数不生效，始终包含。
- `query`：完整类名、驼峰前缀或 `Class#method`；避免单个通用词（`String`、`get`），它们既慢又噪声大。

## 耗时参考（用于选择，不是性能承诺）

术语：**本工具** = 这 4 个 MCP 工具；**Grep** = 全库 ripgrep 搜索，包含进程启动与输出；**独立** = 扩展未启用、由 MCP 启动 JDT LS；**桥接** = IDE 已打开工程、复用其索引。

数据来自一台 Windows 开发机：小型合成工程 10–1000 个 Java 文件 + 一个约 3k 文件的真实业务工程。冷启动时间不计入下表。

| 操作 | 本工具 | Grep | 怎么选 |
|---|---:|---:|---|
| definition | 5–40ms | 50–1500ms | 需要跳定义时优先本工具 |
| diagnostics | 1–8ms | 50–1500ms | IDE 已分析时几乎零成本 |
| 全工程搜符号 | 2–5ms（热） | 50–125ms | 不知道文件时优先；泛化词可退化到秒级 |
| references ≤100 条 | 15–70ms（独立）；约 670ms（桥接真实工程） | 50–1500ms | 更快或约为 Grep 的 1/2，输出更小 |
| references ≈900 条 | 370ms（独立，合成工程） | 136ms（同规模合成工程） | 本工具反而慢：先 `limit` 截断或改用 Grep |
| 命中精度 | 语义精确 | 唯一符号 0.2–20%，热符号 90% | Grep 低精度时要额外核实，成本被低估 |

轻量判断：需要**精确位置、签名或错误清单**时，本工具单次通常 <100ms；全库 Grep 通常从 50ms 起，大仓库可达秒级。唯一例外是近千条 references。

独立 JDT LS 首次调用需 5–6s 启动并导入工程；桥接没有这项成本。磁盘与杀毒软件会显著影响耗时，跨机器只看量级。

## 何时改用 Read / Grep

- 已知文件与大致位置，只想读代码：直接 `Read`，或用 `Grep` 在该文件内定位。
- 字符串常量、注释、TODO/FIXME、日志文案、注解里的文本、SQL 片段。
- YAML/XML/JSON/SQL、前端资源、脚本等非 Java 文件。
- `target/` 等生成目录、工程外源码、独立片段。
- 需要按正则做全量文本盘点，或统计字面量出现次数。
- 需要实现/类型/调用层次，或重命名/重构：本工具只读，不提供。
- 引用接近千条且只想知道大致位置：Grep 更快，之后人工或工具核实。

判断依据是**总耗时 + 结果可信度**：工具胜在语义精确与少返工，Grep 胜在零索引依赖与输出可控。

## 失败与回退

1. **0 条结果**：先 `java_status` 看 `source` / `bridgeError`；确认拼写、文件路径和位置是否落在标识符上。
2. **超时或索引未就绪**：`java_status {warmup:true}` 预热后重试；小任务可先用 Read/Grep，不必等。
3. **依赖 jar 内的符号**：全工程搜符号可能搜不到，从调用处用 `definition` 或 `hover` 更可靠。
4. **工程外 / 非 Java / 生成代码**：直接 Grep/Read，不要反复试工具。
5. 回退文本搜索时，在回答中说明原因与所用方式。

## 数据源

- `ide-bridge`：IDE 里已打开该工程时复用其索引，查询毫秒级；诊断与编辑器里显示的实时错误/警告一致（推荐）。
- `standalone-jdtls`：没有可用的 IDE 桥接时，由 MCP 自行启动 JDT LS；可 `warmup:true` 预热。诊断只覆盖它已分析/已发布的文件，可能比 IDE 里显示的少。

## 注意

- 工具只读，不修改文件、不执行构建。
- 位置以 IDE 编辑器当前内容为准（含未保存修改）；用磁盘文件推算行号时可能偏移。
- 诊断范围：桥接 = IDE 当前已分析的文件（与编辑器里显示的实时错误/警告一致）；独立 = JDT 已发布的诊断，可能不全。两者都不是全仓库静态扫描；最终以构建结果为准。
- 诊断不能替代编译门禁：Lombok/注解处理器与 Maven 不完全等价，最终仍需 `mvnw -DskipTests test-compile`。
- 触发关键词：定义、跳转、引用、调用方、类在哪、方法在哪、字段、签名、编译错误、报错、找不到符号、go to definition、find references、usages、workspace symbol、diagnostics。