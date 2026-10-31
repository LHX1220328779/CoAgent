# 验证记录

## 2026-10-31 双账号真实并发与负载分配

- 按实际控制台协议流程：使用用户配置的 MCP 创建两个独立目录项目、确认固定测试先失败；分别创建任务并自动准备/分配，批准两任务同时执行，按 Native callID 对唯一目标文件补丁及准确测试命令单次审批。无需复制会话网址，两个 Worker 实际属于不同账号。
- 任务 `3099ff8a-7a34-43ee-a317-ef47cf0b2020` 修复姓名去空白/小写转换；`4634a98a-5385-4427-a719-d7b083a323d3` 修复分数上下界限制。两个账号均通过 MCP 完成读取、补丁、复读、命令，各 3 项测试通过；独立 Reviewer 原生父子关系和 Supervisor 外部验收事件均存在，测试文件逐字节未变，原始标题与目录匹配。
- Worker 协议轮次实测最大重叠 **12326ms**，最终两个任务均 succeeded；这证明该样例的真实跨账号重叠，不是串行基线对比、总体加速倍数或高并发保证。桥接模型通道共 15 轮、40 次 HTTP（含一次显式审查恢复，不含发现、MCP 和只读排障），DOM 操作 0，未启动浏览器。
- 首次 clamp 审查失败：存储于 Arena 的原始答复只有一个文本 part，缺少最终结束标记；与流解析截断区分后保留严格拒绝。将完整响应契约移到提示末尾并改进评审 JSON 示例后，显式恢复同一 Reviewer，未重跑 Worker，审查与外部验收通过。初次失败保留于 `initial-result.json`，不改写为一次即成功。
- 新分配测试验证：繁忙账号仍有成功空闲会话时，新 Worker 选择较少负载账号；重复分配不改绑；完成任务保留独占但不算当前负载；进入审查阶段按 Reviewer 所属账号计算负载。
- `node --test tests/arena-pool.test.ts tests/arena.test.ts tests/runtime.test.ts tests/integration/arena-opencode.test.ts`：12 项通过，模型上游为 Fixture，实际启动固定 OpenCode 执行本地工具；最终补充审查阶段负载后又运行分配/进程集成 3 项。类型检查通过。新增缺失结束标记拒绝及已知错误静态提示用例，不回显上游正文。
- 私有证据：`.coagent/parallel-acceptance/{setup,progress,result,initial-result,failure-diagnosis}.json`，以及受控重启前的协议时间记录。测试资源在成功后由本轮显式归还四条，代码、Native 历史与失败证据保留；本轮未修改模型、代理、并发或 MCP 配置。

## 2026-10-31 核心协议、依赖开发与隐私

- 真实账号、真实 Arena HTTP / V2 SSE、用户授权 MCP：任务 `core-math-1793410831523` 在独立 Git worktree 修复 `math_ops.py`，3 项 Python 单测通过；显式归还两条会话后，依赖任务 `core-report-1793411163715` 自动复用同两条 Arena 会话并创建新 Native 上下文，在该实际目录修复 `report.py`，6 项测试通过。
- 两个任务最终均 succeeded，均有独立 Reviewer 的原生父子关系及 Supervisor `acceptance_passed` 事件。实际变更仅两个源文件；测试、忽略文件及原项目 Git 基线逐字节未变，没有代替模型手工修复。证据私有保留在 `.coagent/core-acceptance/`。
- 第二阶段首次 Reviewer 返回上一轮 request_id，严格校验拒绝；该失败独立记录。将当前响应契约补充到请求末尾后，显式恢复同任务，只继续保留的审查检查点；Worker 的工具 callID 集合未增，最终审查与外部验收通过。没有自动重放、切换账号或把旧输出当作成功。
- 16 个真实模型轮次（含被拒绝的旧标识输出及显式恢复）共 42 次上游 HTTP，11 轮无额外授权请求，DOM 操作 0，浏览器未启动。性能记录实际发送 610058 字节；相同请求每轮完整发送历史为 814222 字节，减少 **25.07%**。这是字节比较，不是实测 token 节省或模型加速比例；首条 SSE record 也不是首个模型 token。
- 本轮在线开发使用同一账号的两个独立 Arena 会话。跨账号并发与每账号单轮限制由受控协议测试验证，尚未取得真实双账号并发收益数据，不扩大结论。
- `npm run check` 通过；`node --test tests/arena.test.ts tests/arena-pool.test.ts tests/arena-protocol.test.ts tests/mcp-text-bridge.test.ts tests/runtime.test.ts tests/desktop.test.ts tests/acp.test.ts tests/integration/arena-opencode.test.ts`：**35 项通过**。集成启动实际 OpenCode 1.19.5、执行真实本地工具、审批、审查及验收，模型上游为 Fixture，与上面的在线 Arena 验收分开。
- 隐私定向验证：本机 HTTP 服务实际返回 307 重定向，MCP 工具请求及控制台登录密码均未转发到第二个目标；协议请求断言只访问 Arena HTTPS 且拒绝重定向；诊断内容不含模型正文与消息；受管理 Runtime 的自动下载和项目配置开关生效。未执行全网流量审计，也不保证上游或指定隧道不记录数据。
- 本机显式 HTTP 代理下 MCP 请求曾出现 TLS/socket 失败；同一端点通过用户已有 TUN 正常 initialize / tools/list / 文件操作。仅为该 MCP 主机保留 NO_PROXY 例外，未变更 Arena 路由或绕过服务端目录权限。

## 2026-10-31 ACP 客户端适配

- 最终 `npm run check` 通过；`node --test tests/acp.test.ts tests/integration/arena-opencode.test.ts` 的 **9 项测试全部通过**（8 项 ACP 契约 + 1 项真实 OpenCode 进程集成）。未重复无关的全量测试。
- 本轮沿用 OpenCode V1 1.19.5 和现有 Supervisor / ArenaPool，新增 ACP v1 stdio 入口；没有升级依赖、调用 Devin 原生模型或恢复旧 Electron UI WIP。
- 实际执行 `启动CoAgentACP.sh` 的 JSON-RPC 初始化：退出 0，协商 protocolVersion=1，stdout 只有一条有效协议响应，没有启动模型请求。
- ACP 契约覆盖创建/续接/持久历史重放、角色原始标题、真实工具输入输出映射、仅本次审批、拒绝未知选项、任务失败不报告 end_turn、准备中取消不再批准任务、同一会话并发独占，以及 registry 合并保留其他 Agent。新增取消测试使用阶段同步，避免依赖进程启动耗时。
- 固定版真实 OpenCode 的 ACP 进程链路：`ACP → CoAgent 控制 API → Supervisor / ArenaPool → OpenCode`，自动分配两个账号的会话及原始标题；客户端批准真实 shell 工具，实际写入本机 proof.txt；独立 Reviewer 为原生子会话，Supervisor 外部验收通过。随后沿用同一 Native Session 追加需求，重新连接后重放历史不增加执行次数；显式归还后可重新分配，再归还。
- 审批关联使用 OpenCode Permission 的 tool.callID 和原生工具 callID；不以“最后一个待执行工具”猜测命令。无法关联且缺少原生命令信息时只提供拒绝选项。
- 上述进程测试中的模型响应、账号和会话历史来自受控 Fixture；文件、命令、Runtime、审查和外部验收为真实本机执行。不是本轮新的 Arena 在线模型或远程 MCP 验收，之前在线成功/失败边界继续保留。
- Devin Desktop 本机尚未安装；没有运行用户 registry 注册命令，也没有验证其窗口、版本、自动 MCP 注入及界面布局。不能将通用 ACP 客户端验证描述为 Devin Desktop 图形 E2E 已通过。

## 2026-10-31 协议与 MCP 真实流程联调（部分通过）

- 任务传输使用已认证 HTTP append / V2 SSE，`domActions=0`；历史发现改为分页 HTTP 接口，保留实际标题、所属账号及任务独占关系。登录窗口的安全验证与任务协议分开，不绕过验证或静默回退 DOM。
- 真实消息校验失败已复现并修复：按当前客户端使用 UUIDv7、真实上一用户消息 nodeId 及会话 triggerAddress。修正后得到实际 MCP 工具请求。新会话的初始历史可能含无输入编号的结束标记；适配器丢弃该组，只返回明确匹配输入序号的结果，包括合法的输入 0。
- ShunCode Bridge 0.7.4 的 tools/list 声明 outputSchema，实际工具响应却只有纯文本 content。MCP 规范要求声明该字段时提供对应 structuredContent；新增可选文本桥接，保留输入 Schema、原始内容及错误，不扩大权限。[MCP 工具规范](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#output-schema)
- 新文本桥接实际连接用户服务：initialize、15 项工具发现、真实文件读取及 OpenCode connected。真实 Sidekick 已通过 MCP 列目录、读固定源文件和测试、apply_patch 修复加法、复读、run_command 执行 Node 测试退出 0；测试内容未改。首次 Reviewer 因缺少可核查操作记录而拒绝；补充实际 OpenCode 工具历史（含读取基线、补丁和命令输出）后再次审查 approved，Supervisor 独立外部验收通过，任务首次 succeeded。随后同任务追加需求也成功：两个原生 Session 与 Arena 绑定保持一致，历史实际增加，Reviewer 仍为 Worker 原生子会话，两轮外部验收均通过。
- 通过真实控制台 HTTP 验证：任务 A 正在执行时，任务 B 使用其他两条带原始标题的会话；抢绑 A 会话和归还 A 资源均为 409；B 暂停/恢复保留原上下文且仍需批准；取消保留占用；显式归还 2 条后，新任务 C 自动取得这两条 Arena 会话及全新的 OpenCode 会话，并创建独立 Git worktree。C 的模型拒绝文本工具协议且未修改文件；通过正常 followup 澄清执行器契约后仍未完成，审查响应也不符合帧格式；没有替换模型或伪造文件。该项保留为失败证据，不计为通过。
- 真实暂停的一个上游输入收到 stop HTTP 确认，后续只读输出核实 turn-complete；没有工具或文件副作用。接收状态不确定的请求先核对，不自动重放。
- 修复 Runtime 长请求被 fetch 默认响应头超时提前中断。真实本机 HTTP 对照等待 307 秒：旧 fetch 在 300682 毫秒报 UND_ERR_HEADERS_TIMEOUT；新任务 HTTP 在 307022 毫秒正常完成，并保留任务 AbortSignal。该项为传输对照，不调用模型。[Undici 超时说明](https://github.com/nodejs/undici/blob/main/docs/docs/api/Client.md)
- 本机发送预算由 65536 调整为 131072 字节，以容纳此次多次恢复后的完整任务历史；属于本地限制，不代表 Arena 官方模型上限。
- 最新类型检查和 52 项常规测试通过；3 项真实 OpenCode / LiteLLM 进程集成通过（模型上游为受控 Fixture）。浏览器点击与视觉 E2E 尚未验证。
- 私有证据：`.coagent/live-user-acceptance/` 下 setup / progress / progress-git / control-flow / long-request / result 等 JSON，含本机任务数据，不提交 Git。

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

## 登录异常的真实复现与修复

- 同一账号：原后台无头登录本地 HTTP 422 / 首页 Arena 403，约 1.3 秒；显式配置浏览器代理后无头仍首页 403，约 2.3 秒；改用可见 Chrome 后登录 HTTP 200，约 15.9 秒，认证 Cookie 与自身账号页面检查均通过。
- 用户网络为 TUN + 规则模式。因此仅能确认浏览器运行环境与结果存在直接差异，不能把代理遗漏当作唯一根因，也不能在无上游依据时断言某个指纹字段或账号封禁。独立网页的截图是邮箱提供方识别错误，与后台首页 403 属于不同阶段。
- 登录上下文改为普通可见 Chrome；不使用第三方指纹修改脚本。实际重启后仅靠保存的 Cookie 恢复账号就绪，无再次密码提交。最终版本第二账号登录 HTTP 200，约 20.6 秒；两个账号均就绪，禁用数 0，实际发现 20 条会话。
- “网页登录”使用已有账号上下文；实际打开与确认接口均返回 200，原会话和其他账号保留。未把此结果宣称为全新账号网页邮箱识别流程通过。
- `npm run check`、桥接 JavaScript 语法检查，以及 `node --test tests/arena-login.test.ts tests/desktop.test.ts` 的 6 项相关测试通过。私有脱敏证据为 `.coagent/login-diagnosis.json`，不含账号凭据；本轮没有调用真实模型或消耗 Agent 任务额度。

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
