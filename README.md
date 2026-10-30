# CoAgent

本地 TypeScript Supervisor + OpenCode V1 + 可插拔模型网关。首要研究目标是接入用户授权的 **Arena Agent 网页免费额度**；不要求使用付费推理 API，不提供配额或验证绕过。

已实现任务 DAG、持久会话、独立 Worktree、Reviewer、审批/暂停/取消/恢复、协议校验和事件流。已通过 Arena 在线小任务的本地编辑、独立审查及外部测试验收；首次使用需要已登录的本机桥接和独立网页会话。真实证据见 [测试记录](docs/validation.md)，完整范围与限制见 [技术方案](docs/technical-design.md)。

日常操作从根目录 [使用手册](使用手册.md) 开始；接续开发先读 [开发状态](开发状态.md)。

## 环境与启动

要求 Node 24、npm、Git。Python/LiteLLM 只在 `litellm` 模式需要。OpenCode 固定 1.19.5，局部安装，不覆盖全局命令。

```bash
npm ci
cp .env.example .env
```

编辑 `.env`，为 `COAGENT_API_KEY` 和 `OPENCODE_SERVER_PASSWORD` 设置不同的本地随机密钥。它们仅保护本机服务，**不是模型供应商 API key**。

启动本地网页控制台：

```bash
npm start
```

默认打开 `http://127.0.0.1:4312`，自动启动缺少的组件并复用已有服务；重复启动连接已有控制台。首次启动会安装 Ubuntu 应用菜单入口 **CoAgent**；以后可从应用菜单打开，或双击/运行根目录 `启动CoAgent.sh`。页面支持项目选择、创建与准备任务、Arena 会话网址绑定、执行确认、单次工具审批、暂停/恢复/取消、报告和 diff。

默认 `mock` 模式仅演示协议，不能自主完成编程。实际 Arena 使用见 [Arena 接入](docs/arena.md)。Runtime 使用 `.coagent/runtime` 的独立配置和会话目录。默认网关端口 4310、Runtime 4096；本机 `.env` 已将网关设为 4311。调试底层服务时可分别使用 `npm run coagent -- serve` 和 `npm run coagent -- runtime`。

目标目录必须是已有提交的 Git 仓库，不能只包含未提交文件。新建 `task.json`：

```json
{
  "id": "first-task",
  "title": "修复一个明确的问题",
  "repo": "/absolute/path/to/your/repository",
  "prompt": "描述具体变更、涉及文件与验收标准",
  "requiresApproval": true,
  "acceptance": ["npm", "test"]
}
```

```bash
npm run coagent -- submit task.json
npm run coagent -- prepare first-task
npm run coagent -- sessions
# Arena 模式：先按 docs/arena.md 绑定会话。
npm run coagent -- approve first-task
npm run coagent -- events
npm run coagent -- show first-task
```

验收命令是 argv 数组，不经 shell 解释。先核对命令再批准。`succeeded` 表示 Reviewer 同意且配置的验收命令退出 0；未配置验收命令时不代表测试已通过。修改保留在返回的 worktree 路径，**不会自动提交或合并到主工作目录**。

其他命令：`list`、`metrics`、`pause <id>`、`resume <id>`、`cancel <id>`。Arena 模式可用 `bind <OpenCode session ID> <Arena UUID>` 绑定已有网页会话。`plan goal.json` 调用 Lead 生成最多四个待审批任务；Arena 模式先用 `plan-prepare goal.json` 创建并绑定 Lead Session，详见接入说明。恢复中断任务前检查工作目录；无法确认 Runtime 已停止时，任务保持暂停，复用会话前必须成功停止旧执行。

高风险 OpenCode 工具需要 Runtime 自身批准，可在控制台查看命令并选择仅本次允许或拒绝；Reviewer/Explorer 禁止 shell 和写入。TUI 连接方法见根目录使用手册。

## LiteLLM 可选路径

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

设置 `COAGENT_MODE=litellm` 以及 `UPSTREAM_BASE_URL`、`UPSTREAM_API_KEY`、`LEAD_UPSTREAM_MODEL`、`SIDEKICK_UPSTREAM_MODEL`、`REVIEWER_UPSTREAM_MODEL`。OpenAI 兼容上游的模型格式为 `openai/<真实模型ID>`。不要填写不存在的模型。

在加载了这些环境变量的终端运行：

```bash
LITELLM_USE_CHAT_COMPLETIONS_URL_FOR_ANTHROPIC_MESSAGES=1 .venv/bin/litellm --config config/litellm.yaml --host 127.0.0.1 --port 4000
```

此路径用于已有授权上游，不是 Arena 网页免费额度的替代承诺。Chat 经能力校验，Responses/Messages 委托 LiteLLM。

## 验证

```bash
npm run check
npm test
npm run test:integration
```

集成测试启动真实 OpenCode，使用临时仓库和受控模型，实际写文件并验证历史和子 Agent 路由；不消耗付费模型额度。LiteLLM 测试需要先安装上述 Python 依赖。测试不使用 Arena 登录状态，不对真实免费服务压测。

[研究方案](docs/technical-design.md) · [Arena 接入](docs/arena.md) · [验收记录](docs/validation.md)
