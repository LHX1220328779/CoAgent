# Arena Agent 免费额度接入

这里使用的是 Arena 网页 Agent 会话，不是付费 API。CoAgent 不能替你生成免费额度；实际可用性由你的账号、授权和服务状态决定。首次使用需启动本机桥接、正常登录并准备独立会话；实际在线验收结果见 [验证记录](validation.md)。

本机日常使用推荐打开应用菜单 **CoAgent**，或运行 `npm start` 后进入 `http://127.0.0.1:4312`。控制台会复用已有服务并启动缺少的组件，支持多账号登录、已有会话发现、原始标题、任务独占分配和工具审批；完整步骤见根目录 [使用手册](../使用手册.md)。普通任务无需复制网址。

## 启用本机桥接

先将已授权的 [arena-local-bridge](https://github.com/Gandhara2077/arena-local-bridge) 安装到根目录同名文件夹，并准备其 Chrome/Edge 依赖。CoAgent 使用 Node 24，通过自己的 `src/arena/bridge-entry.mjs` 入口加载已安装模块，不修改第三方源码。日常由客户端启动此入口，在客户端正常登录。不要同时运行另一份上游桥接占用同一端口，也不要把密码、Cookie 或 key 提交到仓库。

第三方模块源码安装：

```bash
git clone https://github.com/Gandhara2077/arena-local-bridge.git
cd arena-local-bridge
npm install
cd ..
npm start
```

先按根目录手册设置 `.env` 的本机鉴权值。客户端支持密码登录或打开普通 Arena 登录窗口，网页验证由用户正常完成。每次密码登录只尝试一次；重启仅用尚未过期的已保存 Cookie 读取历史确认状态，不自动提交密码。上游 Windows portable release 不包含 CoAgent 新的会话发现接口，不能直接视作同一集成版本。

最小请求验收：

```bash
export ARENA_AGENT_BRIDGE_KEY='桥接服务显示的本机 key'
curl -sS http://127.0.0.1:20140/health
curl -sS http://127.0.0.1:20140/ready
curl -sS http://127.0.0.1:20140/v1/models \
  -H "Authorization: Bearer $ARENA_AGENT_BRIDGE_KEY"
```

上游桥接使用 `x-codex-session-id` 关联调用方会话，使用已有 Arena 会话 UUID 作为 `model`；本项目会自动发送这两个字段。

## 组件分工

Arena 网页提供模型会话；用户本机桥接服务把现有授权会话暴露成 OpenAI Chat API；CoAgent 校验工具调用、维护任务并交给 OpenCode 执行本地工具。Arena 自身远程工作区中的工具执行不能当成本地项目变更。

适配目标为 [arena-local-bridge](https://github.com/Gandhara2077/arena-local-bridge) 的 `/v1/chat/completions`、Bearer 鉴权和现有会话 UUID 模型选择。核查源码版本为 `403122cf575b82aa519cad7c81a4cfe7d224d474`。集成入口另提供 `/coagent/sessions` 和用户主动触发的普通登录；不运行账号采集、自动重登或批量创建会话，也不保证第三方后续版本兼容。

账号数据、发现目录及桥接归档在 `.coagent/arena-bridge/`；按用户明确要求，测试账号资料明文保存，仅本机用户可读，不进入 Git。发现只读取账号可访问的网页历史链接及标题，并尝试滚动加载历史；不向模型发送探测消息，不创建新会话。页面变更或未加载的历史仍需真实登录后核对，不能假定列表绝对完整。

## 配置

在 `.env` 设置：

```dotenv
COAGENT_MODE=arena
ARENA_BRIDGE_URL=http://127.0.0.1:20140/v1
ARENA_BRIDGE_KEY=你的本机桥接服务密钥
ARENA_SESSION_BINDINGS=.coagent/arena-sessions.json
COAGENT_ALLOW_SIMULATED_TOOLS=1
# 可选：本地请求字节预算，不是上游模型官方上下文上限。
ARENA_CONTEXT_BUDGET_BYTES=65536
```

这里的桥接密钥仅用于本地 HTTP 鉴权，不是 Arena 官方推理 API key。`COAGENT_ALLOW_SIMULATED_TOOLS=1` 明确允许实验性文本工具协议；不设置时仍可研究文本聊天，但含工具的 Coding 请求会被拒绝。

只接受回环桥接地址。整个 Arena 网关最多一个请求、Supervisor 最多一个 Worker，无自动重试、无账号轮换、无跨服务 fallback。桥接返回 401/403/429 或一回合失败时，模型入口返回本地 HTTP 422 和 `arena_authorization_required`、`arena_quota_exhausted` 或 `arena_turn_interrupted`。这是需要人工处理的本地前置条件错误：固定版 OpenCode 的 SDK 也会自动重试 409/429/5xx，直接透传这些状态会重复请求网页上游。错误的原始状态保留在内部 cause，不将供应商诊断正文发送给模型客户端。

## 会话隔离与准备

1. 启动客户端，依次登录自己的账号，点“同步已有会话”，查看各会话原始标题及所属账号。
2. 选择本地目录，提交明确小任务。默认原地开发，也可选 Git worktree；CLI/API 的普通目录任务需设置 `workspaceMode: "direct"`。
3. 页面自动准备；CLI 用 `npm run coagent -- prepare <task-id>`。准备为该任务建立独立 Sidekick、Reviewer OpenCode Session，并原子分配两条未被占用的 Arena 会话，不调用模型。
4. 不足两条时保持等待，处理登录/同步或显式归还旧会话后点“自动分配会话”。其他任务的已占用会话不能借用；遇到错误也不自动换账号。
5. 批准具体任务，查看实际命令、文件工具、Reviewer 和外部测试结果。同任务后续对话保留原 Session、绑定及历史。
6. 成功、失败和取消均保留占用；仅任务停止且确认后，点“解绑并归还会话”才可供新任务分配。归还不删除历史；若旧任务之后继续，也需重新分配可用会话。

SQLite `arena_catalog` 保存原始标题和账号，`arena_leases` 通过唯一约束记录任务独占。`.coagent/arena-sessions.json` 为原子写入的桥接映射，不应手动编辑以绕过租约；高级 `bind` 仅用于无任务归属的 Lead。Reviewer 是 Worker 的原生子会话，同时使用独立模型上下文。

V1 `chat.headers` 插件把真实 Session ID 传给网关，适配器将其转发为桥接的 `x-codex-session-id`，并用映射的现有 Arena UUID 作为模型。禁止两个 OpenCode Session 共享一个 Arena UUID。不会根据第一条 prompt 猜测会话身份，也不会默默切换到 active/自动创建会话。

## UUID 会话的工具协议

核查到的上游 `converse()` 路径只发送最后一条用户文本，并返回普通文本；它不自动处理 Chat 请求中的工具定义和历史工具结果。因此 CoAgent 将完整消息、工具 Schema 和本轮标识序列化为一条用户消息，再将模型明确输出的 `<coagent_tool_call>` 帧转换为 OpenCode 工具调用。

工具名、参数 Schema 和调用结果 ID 仍严格校验。带前导说明的帧必须包含本轮准确的随机标识；错误标识、残缺 JSON 和未知工具不会被执行。工具协议回合先缓冲完整响应再解析，因此 Arena 模式的 SSE 不代表逐 Token 的实时展示；原生 Chat/LiteLLM 路径仍支持增量文本。

最终答复使用带同一本轮标识的 `<coagent_final>` 帧，适配器只交付其中的 `content`。Reviewer 的 `content` 直接放置审查 JSON 对象，避免前导说明混入 Supervisor 的 JSON 解析；不从任意自然语言中猜测或补造审查结论。

审查传输或格式出错时保留已完成的 Worker 报告，`resume` 从 Reviewer 继续；若审查明确拒绝或验收测试失败，则后续恢复重新交给 Worker。

可通过 `submit` 明确提供任务 DAG；也可先运行 `npm run coagent -- plan-prepare goal.json` 创建持久 Lead Session，在绑定文件中加入其独立 Arena 会话后，再运行 `npm run coagent -- plan goal.json`。两条命令复用同一仓库的 Lead Session，不会每次创建未绑定会话。

## 实验边界

- 文本模拟生成 JSON 通过 Schema 只证明格式正确，不能证明命令可信。执行审批由 OpenCode 控制。
- 桥接若声称远端工具已执行，本地没有相应文件及工具结果，则验收失败。
- 会话身份不等于模型身份。不能把网页模型名当作收费模型质量保证。
- CoAgent 的取消会断开本地请求、停止 Runtime；桥接是否中断远端 Agent 仍需实际验证。未确定远端停止前不要重放任务。
- 默认保守 32768 字节上下文预算、4096 输出预算并非 Arena 官方保证值；可用 `ARENA_CONTEXT_BUDGET_BYTES` 调整本地预算，Runtime 启动时同步模型限制。本机实验使用 65536 字节。过长请求会被本地拒绝，应先在 Runtime 做明确摘要。Arena 模式的子任务由 Supervisor 调度，避免 Runtime 临时生成未绑定的子会话。
- 排查协议时可显式设置 `COAGENT_ARENA_DEBUG_DIR=.coagent/arena-responses`，模型返回仅写入本机权限受限的文件；这些文件可能含项目内容，排查后应关闭该配置，不提交到仓库。
- 不进行并发压测来试探免费额度。先完成一次小任务与工具结果往返，记录实际响应和额度，再决定是否扩大实验。

## 首次线上验收记录

2026-10-30 已通过用户授权的两条现有 Arena Agent 会话，实际完成本地 `sum.cjs` 的读取、修改、复读、独立审查及外部 Node 测试，任务状态为 `succeeded`。桥接版本为 1.1.0，Runtime 为 OpenCode 1.19.5；详细证据与联调失败记录见 [验证记录](validation.md)。未使用付费模型 API。

本轮两个测试账号各一次密码登录均收到 Arena 403；用户随后确认普通网页登录也被拒绝。停止重复登录，未据此判定永久封禁。新会话池的自动分配、跨账号元数据、原始标题、命令审批、续接和归还已用真实 OpenCode + 受控上游测试；真实账号的历史发现及新模型任务仍待登录恢复后验收，不能用旧小任务证据替代。

线上取消、真实额度耗尽、长时间稳定性及多 Agent 性能对比尚未验证；本地 Fixture 的对应测试不能代替这些线上结果。
