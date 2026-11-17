# 生产计费实施计划

## Primary goal

用户通过微信或支付宝购买套餐和积分包后，权益可靠到账；每次付费执行先预留、按实际消耗结算，不透支、不重复扣费，并能查看与支付渠道及 Lago 可核对的消费明细。

状态：实施计划，未实施生产账本或渠道支付。以 [计费规则](billing.md)、[ADR 0003](../adr/0003-openbot-ledger-lago-billing.md)、[时区映射](billing-timezone-mapping.md) 和 [验收证据](billing-acceptance.md) 为基线。保留 Lago 社区版：OpenBot 管北京时间周期及人民币收退款，Lago 保持 UTC、零金额汇总，不成为第二套余额。

## 当前源码定位与实施范围

**找到了历史后端，尚未取得与当前运行镜像匹配的可构建后端。** 当前分支的 `server/`、`toolkit/`、`worker/` 在提交 `f71b0f4b` 被移除；移除前完整基线为 `6d1919a3b53a0730894258f197f3beb4e8db4f2f`。可只读查看：`git show 6d1919a3:server/src/agents/turn-admission.ts`。本次未恢复旧文件，也未替换运行镜像。

当前 [docker-compose.yml](../../docker-compose.yml:70) 运行 `/app/bin/openbot server`，镜像来自 `ghcr.io/copilotkit/openbot`；[backend-images.env](../../backend-images.env) 的默认 tag 为会移动的 `main`。只读检查的运行镜像包含编译可执行文件和迁移文件，没有发现完整可编辑后端。OCI source 指向公开 OpenBot 仓库，但没有可用于核对的 revision 标签；不能凭该标签证明历史提交匹配当前二进制。搜索范围包括本仓库当前树、历史树、IdeaProjects 相邻项目及运行镜像，不代表不存在私有服务端仓库。

本次记录的运行镜像摘要为 `sha256:58c6637b6f8250fbb2cea20b37c382ba7a9cebab145b6b164481c78031202084`，OCI version 为 `24.04`；这些只是定位证据，不是源码版本匹配证明。当前上游公开 [OpenBot 仓库](https://github.com/CopilotKit/OpenBot) 也未提供当前 server 目录。

历史后端使用 Bun、TypeScript、Hono、Drizzle 和 PostgreSQL，依据该基线的 `server/package.json`。恢复维护历史分支是一条需要单独兼容性验证的路径，不能把旧 server 单目录直接拷回当前前端、共享包及数据库。

| 工作 | 当前仓库能否推进 | 边界 |
| --- | --- | --- |
| 领域规则、接口合同、测试场景、Lago 适配器 | 可以 | 当前已有实际 Lago 证据；新增 API 不代表镜像已实现 |
| 生产 PostgreSQL 账本模块及独立测试服务 | 可新增、隔离开发 | 新模块位置建议 `services/billing/`，不是现存目录；正式挂载到后端必须过身份和执行链路关卡 |
| 支付适配器、测试收银台、通知/查单状态机 | 可新增、先测试模式 | 真正商户产品、密钥、域名及渠道联调另有依赖 |
| Web 余额、套餐、收银台、退款页面和生成客户端 | 可以开发 | 在后端能力未就绪时关闭生产购买入口，不用 mock 宣称已上线 |
| LangGraph 外部 Harness 的逐模型调用钩子 | 可以修改 | 只覆盖本仓库样例，无法覆盖内建 Bot、其他 Harness 和后台辅助调用 |
| 全部 Run、后台任务、工具、计算机的不可绕过计费 | 当前受阻 | 需匹配后端源码或等效、可验证的服务端扩展接口 |

新账务模块建议复用历史后端的 Bun/TypeScript/Drizzle/PostgreSQL 技术路线，独立测试、内部接口调用；最终嵌入后端还是独立部署在阶段 1 按可取得的服务端能力确定。账本属于 OpenBot 业务域，不因独立进程而交给 Lago 管理。

## 阶段 0：文档与接口发现（已完成事实核查）

**How this serves the primary goal:** 确保支付和扣费调用落在真实可用的接口上，避免实现完成后才发现关键链路不可接入。

实施依据与允许使用的现有接口：

| 来源 | 已确认能力 / 可复制位置 | 不能假设的能力 |
| --- | --- | --- |
| [API README](../../api/README.md) | 分领域 YAML、组织作用域、problem+json、写入幂等键、cursor/limit；`bun run api:generate` | 没有现成生产 reserve/settle/payment API |
| [accounts.yaml](../../api/openapi/accounts.yaml:549) | 认证、列表与写入幂等合同模式 | 幂等 header 不能代替数据库唯一约束 |
| [schedules.yaml](../../api/openapi/schedules.yaml:234) | runRoutine/listRoutineRuns，另有 runCheckIn、runGoal | HTTP 入口不覆盖服务器定时启动 |
| [Lago 接口核查](lago-interface-mapping.md) | customers、plans、subscriptions、events、事件查询、账单查询 | 社区版不依赖自定义时区、invoiceable=false、通用手工收款记录 |
| [微信 Native](https://pay.wechatpay.cn/doc/v3/merchant/4012791877)、[H5](https://pay.wechatpay.cn/doc/v3/merchant/4012791834) | POST `/v3/pay/transactions/native`、`/h5` | H5 不等于所有内嵌浏览器都能支付 |
| [微信查单](https://pay.wechatpay.cn/doc/v3/merchant/4012791880)、[关单](https://pay.wechatpay.cn/doc/v3/merchant/4012791881) | GET `/v3/pay/transactions/out-trade-no/{out_trade_no}`；POST 同路径 `/close` | 前端回跳不能证明付款成功 |
| [微信退款](https://pay.wechatpay.cn/doc/v3/merchant/4012791883)、[查退款](https://pay.wechatpay.cn/doc/v3/merchant/4012587973) | POST `/v3/refund/domestic/refunds`；GET `/{out_refund_no}` | 退款受理不等于到账完成 |
| [微信通知](https://pay.wechatpay.cn/doc/v3/merchant/4012791882)、[交易账单](https://pay.wechatpay.cn/doc/v3/merchant/4012791866) | 通知验签解密、查单补偿、`GET /v3/bill/tradebill` | 不能只消费 webhook 而不主动查单 |
| [支付宝官方 EasySDK API 表](https://github.com/alipay/alipay-easysdk/blob/master/APIDoc.md) | `alipay.trade.page.pay`、`wap.pay`、`query`、`close`、`refund`、`fastpay.refund.query`、`alipay.data.dataservice.bill.downloadurl.query` | 不猜测对应 v3 REST 路径 |
| [支付宝官方 Node SDK](https://github.com/alipay/alipay-sdk-nodejs-all) | `pageExecute`、`checkNotifySignV2`；API 协议/SDK 版本在实现前固定 | v4 `exec` 已标弃用，不能把旧调用示例混成新 v3 接口 |

验证：新增服务前重新阅读对应文档，固定 SDK/镜像版本；用测试凭据确认实际返回结构。支付宝部分开放平台页面本次不可直接读取，方法名由官方 SDK 文档补证，尚未完成商户联调。

防错：本计划下文 reserve、settle、release 等是**拟新增领域操作**，不是声称现有服务端已有这些 API。支付通知入口需独立外部回调合同及渠道验签，不能强制依赖用户 session；组织/账户由已存在订单解析，不信任通知 URL 或客户端提供的付款人。

## 阶段 1：确定可维护后端与可信执行边界

**How this serves the primary goal:** 确保所有实际收费动作都能在执行前受到账本约束，而非仅在页面上显示余额。

工作：优先取得与目标镜像匹配的服务端源码、构建链及扩展合同，并固定 image digest。若只有历史基线，在独立 worktree 验证完整 server/toolkit/worker/shared 依赖、现有 API 合同、迁移和身份行为，再决定是否作为自维护分支；不覆盖当前工作树、不对生产库运行旧迁移。未完成前允许阶段 2、4、5 的隔离模块开发，不开放真实收费执行。

历史候选钩子（均相对于 `6d1919a3`，不是当前文件）：

| 路径与位置 | 用途 | 需要新增的约束 |
| --- | --- | --- |
| `server/src/agents/turn-admission.ts:12`，`serverTurnAdmission({ownerUserId,agentId,threadId,signal})` | 后台回合准入 | 核实付款归属、停用、Run 上限；它只检查回合，不代替每次资源调用预留 |
| `toolkit/src/run-turn.ts:704,784`，`createTurnRunner` / admission | 通用后台执行框架 | 传播不可伪造的账户、root Run、步骤身份 |
| `server/src/index.ts:2137,2179,2365,2447,2481,2688,2744` | 多种后台 runner 装配 | 建立 Routine/Goal/Check-in/辅助任务覆盖清单，逐一验收 |
| `server/src/copilot.ts:653,2957`，`builtInAgentConfiguration` / `SignRun(...)` | 内建模型配置、Run 签名 | 在兼容现有签名的前提下增加费用归属；签名本身不代表余额预留 |
| `server/src/app.ts:2136`，POST `/api/agent-tools/call` | 可信工具执行入口 | 权限检查后、真实资源操作前预留；工具完成后结算 |
| `server/src/tasks/turn.ts:64,87`，`createTaskTurn` / runTurn | 委派工作入口 | 继承原付款人和预算，不能改扣 Bot 创建者 |

当前可编辑的起点：[main.py:325](../../agent-langgraph-agui/src/main.py:325) 的 `answer → bind_tools(model).ainvoke`、[tool_runtime.py:251](../../agent-langgraph-agui/src/tool_runtime.py:251) 的 `ToolAwareAgent.run`、[tool_runtime.py:435](../../agent-langgraph-agui/src/tool_runtime.py:435) 的工具 callback。复制已有上下文隔离及服务 token 校验模式，不把 `MANAGED_AGENT_TOKEN` 当作某用户的付款授权。

身份前置：按 [Casdoor 设计](casdoor-spec.md) 使用服务端解析的稳定用户与个人空间关系建立 Billing Account；邮箱、客户端 personId、`deployment` actor 均不能作为扣费授权。账户停用规则与后台执行一致。

验收：可重复构建匹配服务端；逐一触发对话、辅助模型、定时、Goal、Check-in、委派、子代理、工具与计算机路径，确认可信付款身份及实际拦截点。无法覆盖的收费路径不开放。

历史基线可复制的行为测试入口：`server/tests/agent-callback-token.test.ts`、`server/tests/agent-handoff-runner.integration.test.ts`、`server/tests/agent-handoff-endtoend.integration.test.ts`、`server/tests/proactive-concurrency.integration.test.ts`、`server/tests/proactive-check-in.integration.test.ts`、`server/tests/goal-routine-link.integration.test.ts`、`toolkit/tests/turn-settle.test.ts`。先阅读测试所依赖的版本与夹具，再扩展付款归属和预算断言；不假定这些测试可以直接在当前检出运行。

## 阶段 2：PostgreSQL 生产积分账本

**How this serves the primary goal:** 用户积分在并发、重试、过期和服务重启时仍能准确预留与结算。

工作：新增账户、价格版本、积分批次、预留及批次分配、结算流水、Run 消费上限、调整记录、持久化待发送记录（outbox）及接口幂等记录。积分用整数微积分，人民币金额用整数分，时间用明确精度的 UTC 瞬时；北京时间原始锚点另存。定义范围限制及舍入规则，禁止浮点计费。

拟新增领域操作：`reserve` 校验账户状态、root Run 剩余额度及批次可用量，锁价并返回预留；`settle` 按实际用量和来源批次提交一次；`release` 处理未消费或未知结果；`appendAdjustment` 以原事件和调整类型唯一标识追加。定义领域状态和事务后再生成传输合同，不预先捏造可调用 URL。

同一事务提交余额变化、流水和 outbox。并发预留对账户及 root Run 使用一致锁顺序，数据库约束保证批次守恒、非负余额、唯一结算；外部模型/支付网络请求不持有数据库事务。未知用量 24 小时后释放，迟到成本归平台；退款冻结额不可用于新预留，恢复冻结还要检查原到期时间。

参考：[规则](billing.md)、[SQLite 行为样例](../../scripts/verify-billing-ledger.py)、[周期样例](../../scripts/verify-billing-periods.py)。样例提供可复制验收案例，不直接复制其 SQLite 连接模型或简化 schema 当作生产实现。

验收：真实 PostgreSQL 多连接争抢、跨周期多批次扣减、16 路重复结算/调整、同键不同内容拒绝、进程在提交前后终止、重新启动重试、outbox 重发、Run 与子代理共用上限；分别核对流水和余额。完成后才将参考模型项目升级为生产验收通过。

## 阶段 3：每次资源调用的不可绕过预留

**How this serves the primary goal:** 用户余额不足时不会继续产生新的平台费用，后台任务也遵守同一消费上限。

工作：依据 [ADR 0004](../adr/0004-bifrost-model-gateway.md) 将平台模型密钥移到 Bifrost，Harness 只持有受限访问凭据。新增受信服务端逐调用校验层，绑定账户、root Run、步骤/调用 ID、模型、价格版本、有效预留及最大用量；选择 Bifrost 扩展还是内部代理前必须验证其能覆盖每个请求。Bifrost 本身预算不能代替积分预留。

在 [main.py:179](../../agent-langgraph-agui/src/main.py:179) 现有 `_retries()` 模式上落实所有平台收费调用 `max_retries=0`；不能继续依赖可选 `openbotSendOnce` 才关闭重试。移除 compose 向付费 Harness 注入平台供应商密钥，阻断直连供应商；保留已确认的现有订阅登录例外，不新增 BYOK 产品能力。

每次实际模型请求完成后按唯一调用最终用量结算；断流、取消、超时进入确定或未知结果流程，不把流式片段重复相加。工具与计算资源也要在真正费用产生前预留，无法约束单步最大成本的路径暂不开放。

参考：[tool_runtime.py:488](../../agent-langgraph-agui/src/tool_runtime.py:488) 的并发工具模式、[parallel_tools.py:27](../../agent-langgraph-agui/src/parallel_tools.py:27) 的 usage 去重语义、[TELEMETRY.md:23](../TELEMETRY.md:23) 的内部辅助调用盲点。为标题/建议等未带上下文的内部调用增加可信费用归属，不能仅消费现有 telemetry 做事后扣分。

验收：无预留、伪造付款人、跨租户凭据、超 Run 上限、直连模型、内部重试均被拒绝；覆盖所有阶段 1 路径。身份或账本不可用停止新调用，Bifrost 故障不回退直连，Lago 故障不影响可可靠入账的执行。

## 阶段 4：微信、支付宝订单与退款

**How this serves the primary goal:** 用户付款后只获得一次权益，退款处理中额度不会被重复消费。

工作：实现订单、渠道支付尝试、渠道交易、通知收件记录、权益发放、退款及冻结的持久状态机。订单保存商品/价格快照、金额币种、账户与 30 分钟到期时间。服务端验签、校验商户/app/订单/金额/币种，再确认付款；支付成功与权益发放使用唯一业务键，订单发放与账本变化可原子提交或可靠补偿。

一个订单可能有多个渠道尝试，但只能履约一次；第二笔成功收款进入异常退款，不能重复发积分。支付关闭与成功通知并发时主动查单，不把本地过期直接等同于渠道未付款。退款复用同一渠道退款标识，未知结果保持冻结并查单；受理成功不等于退款完成。

复制阶段 0 官方接口/SDK 模式，固定版本后验证签名、证书/公钥轮换、通知重放和账单下载校验。微信 Native 用电脑扫码，H5 只覆盖支持的外部手机浏览器；微信内置浏览器或嵌入式浏览器不能假定可用，先明确外部浏览器引导，若需要 JSAPI 则单列商户产品和协议验证。H5 链接有效期与订单 30 分钟生命周期分别管理，刷新链接不得重置订单到期时间。支付宝采用已核验的协议路线，不混用旧命名方法和未经核验的 v3 REST 地址。

真实联调依赖：自有商户号、绑定 appid/app_id、开通的 Native/H5/网站支付产品、公网 HTTPS 回调与域名配置、受控密钥/证书存储。密钥由部署系统注入，不写进仓库、前端或聊天。当前阶段可先完成适配器与伪渠道故障测试，不以此宣称真实支付已通过。

验收：两渠道支付/查单/关单/退款/查退款/对账；验签失败、金额不符、重复/乱序通知、两渠道同时成功、通知丢失、退款未知、回跳但未付、到期关单竞争、支付后进程崩溃均有预期结果。人工退款审核保留操作者与原因。

## 阶段 5：Lago 社区版同步与三方对账

**How this serves the primary goal:** 用户每笔扣分和收退款都有可追踪依据，迟到或重复通知不会变成额外欠款。

工作：固定已验证 Lago 版本和摘要，按稳定账户 ID 创建 customer 与持续计量关系；用零固定费、零单价 sum 指标汇总资源用量和微积分。outbox 按稳定事件 ID 重试，422 仅在核对重复错误及原事件内容后视为已发送；语义冲突转人工，不覆盖原事件。

保留原始整数 occurrence_us，timestamp 由其精确派生。按 [时区设计](billing-timezone-mapping.md) 扩大查询粗筛，再半开区间精筛；分页以本地固定水位预期集合重扫，不以总额相同认定完成。Lago 已出账不变时在本地追加原周期调整。

三组对账分开：渠道人民币交易与订单；本地积分流水与已确认的 Lago 微积分；资源用量与费用承担方。平台故障、自带订阅模型、迟到释放后的成本分别归属，不自动追扣。订单和积分充值不得同时作为新的消费应收重复核算。

参考：[真实 API 验证脚本](../../scripts/verify-lago-concurrency.py)、[月末/迟到脚本](../../scripts/verify-lago-timezone.py)、[零价脚本](../../scripts/verify-lago-zero-price.py)。客户时区、手工付款、invoiceable 门控的限制保持原样，不修改 Lago 核心绕过许可。

验收：真实 outbox 进程重启、Lago 断网恢复、分页并发插入、微秒边界、UTC/BJT 交叉周期、迟到历史调整、同键冲突、每日支付账单不一致报警；所有调整可追溯，缺失事件保持 pending，不修改用户历史账。

## 阶段 6：用户账单与统一收银台

**How this serves the primary goal:** 用户能理解余额、预留、付款确认和退款状态，并主动恢复因余额不足暂停的任务。

工作：在 [app 受登录页面目录](../../app/src/routes/_authed/_app) 增加余额与预留、消费明细、套餐、积分包、订单/退款状态及收银台。复制 [request.ts](../../app/src/lib/api/request.ts:53) 的请求/幂等键模式，API 合同新增 `billing.yaml`（拟新增）并通过生成命令产出客户端，不手改 generated。

公共用户接口遵循组织作用域，服务端解析个人 Billing Account；内部预留/结算接口仅对可信服务开放，不暴露为浏览器任意扣分接口。移动和桌面端统一网页付款，但其登录交接与回跳需要真机验证；不把浏览器 return_url 当成到账依据。

验收：三端正确显示可用/预留/确认中/退款冻结、六位积分及补偿来源；订阅过期仍可买/用积分包；恢复任务需要明确操作，不补跑历史定时任务。商品未正式配置或服务能力未就绪时关闭生产销售。

## 阶段 7：生产级验证与上线门禁

**How this serves the primary goal:** 在真实付费前证明所有收费入口、恢复流程和用户账单保持一致。

工作：依 [验收清单](billing-acceptance.md) 将真实数据库、后端执行、Bifrost、渠道和 Lago 连接成测试环境，再逐步开放测试账户。保留无真实商户的可重复集成测试与故障注入；真实渠道测试与文档模拟结果分别报告。

核对实现与官方接口、合同生成及框架模式一致；执行 `bun run api:generate`、`bun run api:lint`、涉及包的 typecheck 和行为测试。搜索付费 Harness 的供应商密钥直连、自动重试、浮点金额和客户端决定付款人路径，并通过绕过攻击测试验证防护，而不只靠 grep。

上线关卡：匹配后端构建、稳定身份及执行覆盖、PostgreSQL 账本并发与恢复、模型/工具不可绕过预留、双渠道真实闭环、对账重放、正式商业配置全部通过。回滚停止新购买/新消费但保留已接收支付通知、查单、退款和结算处理，不回滚或清空已有账务流水。

## 阻塞项与下一步

| 阻塞项 | 解除所需证据 | 可并行推进 |
| --- | --- | --- |
| 当前后端源码与镜像不匹配 | 匹配源码+构建，或具备全部可信钩子的扩展合同；历史分支需独立兼容验证 | 账本独立模块、合同、Lago worker、前端测试态 |
| 稳定身份与所有执行付款归属 | Casdoor→OpenBot→个人空间映射和停用端到端测试 | schema/合同与伪身份测试，不能真实发放 |
| Bifrost 不可绕过校验未实现 | 无预留不能触达付费模型，后台辅助请求同样覆盖 | 先完成 LangGraph 测试路径；其他路径保持关闭 |
| 商户产品/密钥/公网回调未联调 | 微信支付宝分别通过真实付款与退款核对 | 适配器和签名/通知故障测试 |
| 正式价格、额度、默认上限未确定 | 上线配置清单及版本化快照 | 测试商品，禁止把访谈示例价格当正式售价 |

建议立即执行阶段 1 的版本匹配核查，同时推进阶段 2 的独立 PostgreSQL 模块；不要把历史源码已找到等同于生产拦截已解决。首期继续排除自动扣款、团队共享余额、中途按比例换档、额外 BYOK 产品支持、Lago 商业功能依赖。
