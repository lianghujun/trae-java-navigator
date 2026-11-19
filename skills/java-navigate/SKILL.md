---
name: java-navigate
description: "Use when locating Java classes, methods, or fields, jumping to definitions, finding references, or reading real-time compiler diagnostics in a Java workspace through the java-navigator MCP server."
description_zh: "任务涉及 Java 代码定位、定义跳转、引用查找、编译错误排查时使用。通过 java-navigator MCP 直接查询 IDE 的 JDT LS，不反复运行 Maven。"
description_en: "Use when locating Java classes, methods, or fields, jumping to definitions, finding references, or reading real-time compiler diagnostics in a Java workspace through the java-navigator MCP server."
version: "0.1.2"
---

# Java Navigator

当任务涉及 Java 代码定位、引用查找、编译错误排查时使用本技能。它通过 MCP 工具直接查询 Eclipse JDT LS（redhat.java 的底层语言服务），不需要反复运行 Maven。

## 首要规则

查找 Java 类/方法/字段的位置、引用或编译错误时，**必须先调用本技能的 MCP 工具**：

- “X 类里 Y 方法在哪” → `java_search {class:"X", name:"Y"}`（无需先知道文件）
- 只知道符号名 → `java_search {query:"Y"}`；也可 `java_search {query:"X#Y"}`
- 已知文件 → `java_search {file, name}`
- 引用/定义/签名 → `java_navigate`
- 编译错误 → `java_diagnostics`

**禁止把 Grep/rg/Read 作为查找 Java 符号的首选**。只有工具报错、返回 0 结果或目标不在 Java 工程内时，才回退文本搜索，并在回答中说明回退原因。

## 工具

| 工具 | 用途 |
|---|---|
| `java_search` | `query` 工作区（支持 `X#Y`）；`class`+`name` 类内定位；`file`+`name` 文件内定位；只给 `file` 看结构 |
| `java_navigate` | `action=definition`（含源码行）/ `references` / `hover` |
| `java_diagnostics` | 编译错误：给 `file` 查单文件，省略则查工作区 |
| `java_status` | 数据源与索引状态；`warmup=true` 后台启动索引 |

## 使用约定

1. `file` 可以是绝对路径，也可以是相对 `JAVA_NAV_WORKSPACE` 的路径。
2. `line` / `column` **从 1 开始**（与 IDE 一致），返回结果也是 1-based。
3. 首次查询前调用 `java_status`；未就绪时可 `java_status {warmup:true}` 预热，或直接发起查询（会自动启动兜底 JDT LS）。
4. **已知文件 + 符号名**（如“QualityController 里的 getRule 在哪”）：直接 `java_search {file, name}`，一次拿到行号、容器与签名；不要先拉全量符号再 Grep。
5. **只知道类/方法名**：`java_search {query}`；结果通常带 `summary` 文本行，可直接读。
6. **只看文件结构**：`java_search {file}`，可加 `name`/`kind`/`limit` 过滤，避免大文件输出被截断。
7. 定义/引用/hover：`java_navigate {action, file, line, column}`；definition 结果带 `text` 源码行，可直接引用。
8. 排查编译错误：`java_diagnostics {}`（默认 error），再对具体文件 `java_diagnostics {file}`。
9. Lombok：兜底模式自动附加 lombok agent（`LOMBOK_JAR` → redhat.java 自带 → Lombok 扩展），桥接模式由 IDE 负责；`java_status` 中 `lombok` 可确认。
10. 桥接不可用（扩展未激活、超时、redhat.java 未启动）会自动回退独立 JDT LS；回退原因看 `java_status.bridgeError`。
11. 多窗口：每个窗口有独立桥接文件（`<hash>-<pid>.json`），`java_status.bridge.windowId` 可区分实例。

## 数据源

`java_status` 的 `source` 字段表示当前数据源：

- `ide-bridge`：复用 IDE 的 JDT LS（推荐），诊断与索引都是实时的，无需等待建索引。
- `standalone-jdtls`：桥接扩展未启用，正在用独立 JDT LS 兜底；可 `java_status {warmup:true}` 预热，再等待 `ready=true`。

## 注意

- 工具只读，不会修改文件、不会执行构建。
- 桥接模式下诊断来自 IDE 的 `vscode.languages.getDiagnostics`，与 Problems 面板一致。
- 兜底模式的诊断与 `mvn compile` 在注解处理器/Lombok/生成源码上可能有少量差异。
- **IDE 诊断不能替代编译门禁**：JDT LS 的 classpath、注解处理与 Maven 不完全等价。快速迭代用本技能定位，最终必须跑 `mvnw -DskipTests test-compile`（需要规避增量残留时先 `clean`）。