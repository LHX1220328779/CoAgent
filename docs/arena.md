# Arena Agent 免费额度接入

这里使用的是 Arena 网页 Agent 会话，不是付费 API。CoAgent 不能替你生成免费额度；实际可用性由你的账号、授权和服务状态决定。当前环境没有安装桥接服务，也没有登录会话，因此实际线上链路尚未验收。

## 启用本机桥接

先安装并启动已授权的 [arena-local-bridge](https://github.com/Gandhara2077/arena-local-bridge)。它要求 Chrome/Edge 和 Node.js 20+；Windows 也可以使用其 portable release。启动后在 `http://127.0.0.1:20140/` 完成网页登录，记下本机生成的 bridge key。不要把 Arena 密码、Cookie 或 key 提交到仓库。

源码安装可按上游说明执行：

```bash
git clone https://github.com/Gandhara2077/arena-local-bridge.git
cd arena-local-bridge
npm install
export ARENA_AGENT_BRIDGE_KEY="$(openssl rand -hex 24)"
node bin/login.mjs --email your-account@example.com
node src/index.mjs
```

也可以使用上游的 `install.sh --email ...` 或 Windows portable release。登录完成后先确认 `GET /health`、`GET /ready`，再用 bridge key 调用 `GET /v1/models`；`/ready` 在没有可用会话时不会通过。

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

适配目标为 [arena-local-bridge](https://github.com/Gandhara2077/arena-local-bridge) 的 `/v1/chat/completions`、Bearer 鉴权和现有会话 UUID 模型选择。核查源码版本为 `403122cf575b82aa519cad7c81a4cfe7d224d474`。本项目没有复制或执行其账号采集、验证处理、自动登录和会话批量创建功能，也不保证其后续版本兼容。

需由用户在获授权环境安装桥接、正常登录并确认可用的 Agent 会话。该外部项目有独立安装说明与依赖；本仓库不通过未经核查的远程安装脚本更改你的浏览器或账号。只需对接它提供的本机标准 API，不需要向 CoAgent 提供 Arena 密码。

## 配置

在 `.env` 设置：

```dotenv
COAGENT_MODE=arena
ARENA_BRIDGE_URL=http://127.0.0.1:20140/v1
ARENA_BRIDGE_KEY=你的本机桥接服务密钥
ARENA_SESSION_BINDINGS=.coagent/arena-sessions.json
COAGENT_ALLOW_SIMULATED_TOOLS=1
```

这里的桥接密钥仅用于本地 HTTP 鉴权，不是 Arena 官方推理 API key。`COAGENT_ALLOW_SIMULATED_TOOLS=1` 明确允许实验性文本工具协议；不设置时仍可研究文本聊天，但含工具的 Coding 请求会被拒绝。

只接受回环桥接地址。整个 Arena 网关最多一个请求、Supervisor 最多一个 Worker，无自动重试、无账号轮换、无跨服务 fallback。桥接返回 401/403/429 或一回合失败时，模型入口返回本地 HTTP 422 和 `arena_authorization_required`、`arena_quota_exhausted` 或 `arena_turn_interrupted`。这是需要人工处理的本地前置条件错误：固定版 OpenCode 的 SDK 也会自动重试 409/429/5xx，直接透传这些状态会重复请求网页上游。错误的原始状态保留在内部 cause，不将供应商诊断正文发送给模型客户端。

## 会话隔离与准备

1. 启动 CoAgent 和 Runtime，提交明确的小任务。
2. 执行 `npm run coagent -- prepare <task-id>`。该步骤建立 Worktree、Sidekick 和 Reviewer 的 OpenCode Session，但不调用模型，状态保持等待批准。
3. 执行 `npm run coagent -- sessions`，取得对应的 `runtime_id`。
4. 在你的授权 Arena 环境中为各角色准备独立已有 Agent 会话，获得桥接可使用的会话 UUID。
5. 用命令绑定两个已有网页会话；这些命令仅写入本地映射，不创建 Arena 会话，也不调用模型：

```bash
npm run coagent -- bind ses_真实Sidekick会话ID 已有Sidekick的Arena会话UUID
npm run coagent -- bind ses_真实Reviewer会话ID 已有Reviewer的Arena会话UUID
```

映射保存在 `.coagent/arena-sessions.json`，通过临时文件原子更新并拒绝重复绑定。也可手动维护以下格式，例子中的 ID 必须替换为真实值：

```json
{
  "ses_真实Sidekick会话ID": "00000000-0000-0000-0000-000000000001",
  "ses_真实Reviewer会话ID": "00000000-0000-0000-0000-000000000002"
}
```

6. 批准具体任务，再检查文件、工具回传、Reviewer 和测试结果。

V1 `chat.headers` 插件把真实 Session ID 传给网关，适配器将其转发为桥接的 `x-codex-session-id`，并用映射的现有 Arena UUID 作为模型。禁止两个 OpenCode Session 共享一个 Arena UUID。不会根据第一条 prompt 猜测会话身份，也不会默默切换到 active/自动创建会话。

可通过 `submit` 明确提供任务 DAG；也可先运行 `npm run coagent -- plan-prepare goal.json` 创建持久 Lead Session，在绑定文件中加入其独立 Arena 会话后，再运行 `npm run coagent -- plan goal.json`。两条命令复用同一仓库的 Lead Session，不会每次创建未绑定会话。

## 实验边界

- 文本模拟生成 JSON 通过 Schema 只证明格式正确，不能证明命令可信。执行审批由 OpenCode 控制。
- 桥接若声称远端工具已执行，本地没有相应文件及工具结果，则验收失败。
- 会话身份不等于模型身份。不能把网页模型名当作收费模型质量保证。
- CoAgent 的取消会断开本地请求、停止 Runtime；桥接是否中断远端 Agent 仍需实际验证。未确定远端停止前不要重放任务。
- 默认保守 32768 字节上下文预算、4096 输出预算并非 Arena 官方保证值；Runtime 启动时会生成匹配的模型限制。过长请求会被本地拒绝，应先在 Runtime 做明确摘要。Arena 模式的子任务由 Supervisor 调度，避免 Runtime 临时生成未绑定的子会话。
- 不进行并发压测来试探免费额度。先完成一次小任务与工具结果往返，记录实际响应和额度，再决定是否扩大实验。

## 首次线上验收记录

用户登录后，依次记录：桥接版本、现有会话绑定、工具执行结果、文件 diff、验收命令、Reviewer 结论、取消结果、上下文保留、429/授权失败表现。禁止将本仓库 Mock 测试结果填写为 Arena 在线测试结果。
