# 验证记录

## 2026-10-30 当前工作区

- `npm run test:all`：通过。
- 常规测试：32 项通过，包含 HTTP、Arena 桥接模拟、协议、SQLite 调度和 Worktree；覆盖配置限制联动、绑定 API、取消未确认、禁止工具回合重放，以及 UUID 文本工具协议、最终答复封装和待审查恢复。
- 集成测试：3 项通过。固定版 OpenCode 1.19.5 实际执行工具、子会话路由和重启恢复；LiteLLM 1.106.6 验证 Chat、Responses、Anthropic Messages、SSE 和工具结果往返；新增真实 OpenCode 经 Arena 适配器完成绑定、写入、独立审查和验收。
- 上述自动化测试的模型上游是隔离的本地受控 Fixture。下述 Arena 在线验收另行使用用户授权的真实网页会话。

## Arena Agent 在线验收：已通过

环境：Ubuntu 22、Node 24.21.0、OpenCode 1.19.5、arena-local-bridge 1.1.0。使用用户授权的本机桥接及两个已有的独立 Arena Agent 会话，分别绑定持久 Sidekick 和 Reviewer；未调用付费模型 API。会话 UUID、账号和密钥未写入公开记录。

输入：独立 Git worktree 中，`sum.cjs` 原为 `module.exports = (a, b) => a - b;`。固定的 `sum.test.cjs` 包含一个测试、三个加法断言。修改前真实执行失败（`-1` 不等于 `5`）。要求只修改 `sum.cjs`，通过本地 OpenCode 工具读取并复读，不能用 Arena 远端文件替代。

实际证据：

- Sidekick 的原生 OpenCode 工具历史依次为 `read`、`read`、`edit`、`read`、`bash`，均完成；真实文件变为 `module.exports = (a, b) => a + b;`。
- Git diff 只有上述一行修改；验收测试文件与初始提交逐字相同。
- 独立 Reviewer 会话实际执行两个本地 `read`，最终返回 `approved: true`，Supervisor 记录 `review` 事件。
- Supervisor 在同一 worktree 中执行独立验收 argv `node --test sum.test.cjs`，退出 0，记录 `acceptance_passed`，任务最终为 `succeeded`、`reviewPending: false`。
- 本机保留 `.coagent/live-acceptance-result.json`、`.coagent/live-acceptance-evidence.json`、原生会话历史及 SQLite 事件；这些包含本机任务数据的文件不提交到 Git。

联调共发生 6 次显式执行或恢复，并非首次即通过。实际定位并修复了 UUID 桥接忽略工具与历史、文本帧附带前导说明、请求标识被改写，以及 Reviewer JSON 混入说明等问题。工具执行后失败不会自动重放；新增待审查检查点后，最后一次恢复只继续 Reviewer，未重复 Worker 编辑。未通过修改任务状态跳过审查或测试。

## 本轮复现与修复

- 接手时，24 项常规测试及 LiteLLM 集成通过，但 OpenCode 集成仍检查旧的 `x-session-id`，与实现的 `x-codex-session-id` 不一致；已修正测试并真实通过。
- 原始 Runtime 配置输出上限 8192，高于 Arena 适配器接受的 4096；启动时现按模式生成匹配的 V1 配置，自动同步网关端口。
- 真实 Runtime 实验发现本地返回 HTTP 409 时，配额错误仍被重试，桥接共收到 6 次请求。改用需人工处理的本地 422 后，同一实验确认桥接仅收到 1 次配额失败请求，任务设置 `maxAttempts:3` 也不重放。
- 停止请求未获确认时，会话保留 running 标志，任务保持 paused；后续复用前必须重新确认停止。已提交 Runtime 的工具回合不会因最终暂时错误而自动重放。
- 真实桥接的 UUID `converse()` 路径只消费最后一条用户文本；现将完整消息、工具 Schema 和本轮标识编码到该文本，返回后校验工具帧并交给 OpenCode 执行。最终答复单独解封，审查结果仍须通过 Supervisor 的 JSON 结构校验。
- 本机在线实验将请求预算显式设为 65536 字节，并同步 Runtime 限制；该值是本地配置，不是 Arena 官方模型上下文上限。工具协议回合缓冲完整响应，因此不能将该路径的 SSE 当作逐 Token 实时输出。

## 能力边界

线上结果证明了一个小型本地修复任务的模型—工具—审查—测试完整链路。真实 Lead 规划、多文件复杂任务、远端取消、配额耗尽、多日稳定性和并发性能对比仍未验证。自动化 Fixture 的相关结果不能填作 Arena 在线结果。

未获得可核验的上游 Token、价格或免费额度上限，未知费用仍记为未知，不能据此宣称无限免费。使用已有授权会话，不自动创建账号、轮换身份或突破配额。

LiteLLM 配置只接受用户已授权的上游模型。Responses 和 Anthropic Messages 入口由 LiteLLM 转换；没有可用上游时不能宣称这些协议已完成真实模型验收。
