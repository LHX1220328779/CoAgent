# 验证记录

## 2026-10-30 当前工作区

- `npm run test:all`：通过。
- 常规测试：30 项通过，包含 HTTP、Arena 桥接模拟、协议、SQLite 调度和 Worktree；新增配置限制联动、绑定 API、取消未确认及禁止工具回合重放的回归测试。
- 集成测试：3 项通过。固定版 OpenCode 1.19.5 实际执行工具、子会话路由和重启恢复；LiteLLM 1.106.6 验证 Chat、Responses、Anthropic Messages、SSE 和工具结果往返；新增真实 OpenCode 经 Arena 适配器完成绑定、写入、独立审查和验收。
- 未使用真实模型凭据；上游是隔离的本地受控 Fixture。

## 本轮复现与修复

- 接手时，24 项常规测试及 LiteLLM 集成通过，但 OpenCode 集成仍检查旧的 `x-session-id`，与实现的 `x-codex-session-id` 不一致；已修正测试并真实通过。
- 原始 Runtime 配置输出上限 8192，高于 Arena 适配器接受的 4096；启动时现按模式生成匹配的 V1 配置，自动同步网关端口。
- 真实 Runtime 实验发现本地返回 HTTP 409 时，配额错误仍被重试，桥接共收到 6 次请求。改用需人工处理的本地 422 后，同一实验确认桥接仅收到 1 次配额失败请求，任务设置 `maxAttempts:3` 也不重放。
- 停止请求未获确认时，会话保留 running 标志，任务保持 paused；后续复用前必须重新确认停止。已提交 Runtime 的工具回合不会因最终暂时错误而自动重放。

## 能力边界

协议和 Supervisor 测试使用本地受控 Fixture，不代表真实模型质量、Arena 免费额度、并发上限或网页会话稳定性。Arena 在线验收仍需用户在已登录且获授权的环境中安装本机桥接服务，绑定已有独立会话后执行一次小任务。只需本地桥接地址、（若启用）桥接密钥和已有 Agent 会话 UUID；无需提供账号密码、Cookie 或登录令牌。

LiteLLM 配置只接受用户已授权的上游模型。Responses 和 Anthropic Messages 入口由 LiteLLM 转换；没有可用上游时不能宣称这些协议已完成真实模型验收。
