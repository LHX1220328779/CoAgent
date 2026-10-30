# 验证记录

## 2026-10-30 当前工作区

- `npm run test:all`：通过。
- 完整测试轮次常规测试 37 项通过；增加账号恢复用例后，最终 `npm test` **38 项全部通过**，`npm run check` 与桥接/前端 JavaScript 语法检查通过。包含 HTTP、Arena 桥接模拟、协议、SQLite 调度、Worktree、普通目录、任务独占会话池及本地控制台，覆盖取消未确认、禁止工具回合重放、UUID 文本工具协议、最终答复封装和待审查恢复。
- 集成测试：3 项通过。固定版 OpenCode 1.19.5 实际执行工具、子会话路由和重启恢复；LiteLLM 1.106.6 验证 Chat、Responses、Anthropic Messages、SSE 和工具结果往返；新增真实 OpenCode 经 Arena 适配器完成绑定、写入、独立审查和验收。
- 上述自动化测试的模型上游是隔离的本地受控 Fixture。下述 Arena 在线验收另行使用用户授权的真实网页会话。

## 一键启动与本地控制台

- `tests/desktop.test.ts` 覆盖在随机端口启动实际 Node 子进程、冷启动、并发/重复启动、停止自己创建的组件；复用已有监听服务且不停止它们；区分服务在线与账号禁用/过期状态，以及有效 Cookie 通过一次历史同步恢复、无自动密码登录。
- 通过真实 HTTP 验证控制台创建独立 Git worktree、绑定两个 Arena 网址、确认执行、单次工具审批及会话隔离、审查和外部验收、查看实际 diff/新增文件。模型和原生审批响应使用受控 Fixture。
- 验证缺少页面会话、外部 Host/Origin、对其他 Reviewer 会话的审批被拒绝；失败的登录不自动重试，凭据和供应商错误正文不返回页面。
- 本机实际启动 `http://127.0.0.1:4312` 后，第二次 `npm start` 正常复用并退出；根目录 `启动CoAgent.sh` 也实际运行并复用控制台，已有 20140/4096/4311 服务保留。应用菜单快捷方式已安装，页面与状态接口真实返回 200。
- 最终 `npm run test:all` 通过；`node --check src/desktop/public/app.js` 通过。Browser 技能没有可用实例，未完成浏览器点击及视觉布局验证，不能宣称浏览器 E2E 通过。
- 本轮两个真实测试账号各一次密码登录均由 Arena 返回 403，本地接口以脱敏 422 提示；用户确认在普通网页登录中也被拒绝，虽此前曾成功。停止重复尝试，不推断永久封禁。新账号发现及模型任务尚未在线验收，没有消耗真实模型额度重测。

## 多账号会话池与连续开发

- `tests/arena-pool.test.ts`：实际 HTTP 元数据、SQLite 与绑定文件验证两任务并发争抢只容许一组完整分配；保留原始中文标题及网页改名、完成不归还、显式归还后新任务可用、运行中拒绝解绑、数据库重开保留租约和独立 Session。
- `tests/supervisor.test.ts`：普通无 Git 目录保留原有文件、真实路径解析、重叠目录串行；同目录新任务不共享 Worker Session。
- `tests/integration/opencode.test.ts`：实际 OpenCode 在非 Git 目录运行 Node/npm/Python 版本命令、修改文件并通过独立 Node 测试；也覆盖原有工具、子 Agent 路由和持久化。
- `tests/integration/arena-opencode.test.ts`：实际启动固定 OpenCode 与控制台 HTTP，从同步两个账号的现有会话及原始标题开始，自动分配 Sidekick/Reviewer，审批真实命令，写文件，Reviewer 读取并记录原生父子关系，Supervisor 外部验收。继续原任务沿用上下文；第二任务遇到配额错误仅访问上游一次；第三任务资源不足不能部分占用，必须显式归还后再分配。该项最终再次运行通过。
- 上述模型响应和账号历史元数据来自本地受控 Fixture；证明本地客户端、调度和原生工具流程，不证明 Arena 当前 DOM、历史完整性、真实账号跨账号调用或模型质量。新 `discover.mjs` 的网页滚动发现和可见登录窗口未获成功账号验证。
- 最新代码已在本机重启：先确认无运行/审查任务，再仅停止本工作台自己的组件。工作台概览和桥接登录窗口状态均真实返回 200，Runtime/调度就绪，桥接进程在线但账号未就绪，会话池当前为空；没有为填充数据伪造真实会话。

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
