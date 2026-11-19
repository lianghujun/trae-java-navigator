# 安全策略

## 支持版本

仅维护最新发布版本（当前为 `0.1.x`）。旧版本的问题请先升级再复现。

## 报告安全问题

请使用 GitHub 的**私密漏洞报告**：仓库页 → Security → Advisories → Report a vulnerability。

不要在公开 Issue 中披露可利用细节、桥接 token、日志中的绝对路径或其他敏感信息。

## 范围

- MCP 服务端：`server/`（stdio JSON-RPC、桥接探测、独立 JDT LS 启动）
- 桥接扩展：`extension.js`（仅监听 `127.0.0.1` 的 HTTP 服务、Bearer token 校验）
- 安装与升级脚本：`install.mjs` / `uninstall.mjs`

不在范围内：

- `redhat.java` / Eclipse JDT LS 自身的问题（请向对应项目报告）
- IDE 或 MCP 客户端的实现问题
- 用户本机既有的 JDT LS 缓存与权限配置

## 已知设计约束

- 桥接服务只绑定回环地址，请求需携带随机 token；桥接文件写入系统临时目录
- 索引与运行数据默认落在临时目录，工程目录只读
- 日志与桥接文件可能包含绝对路径，提交 Issue 前请先脱敏

## 处理流程

确认问题后会在后续版本修复，并在发布说明中标注。修复前请避免公开细节。