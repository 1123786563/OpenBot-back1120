# 权限与边界

本页是代码和 API 暴露出的权限维度，不是已验证的服务端鉴权执行顺序。具体动作审批的产品规则继续以 [Approvals](../approvals.md) 为入口。

## 组织边界

当前前端先读取人的组织，再确定请求归属；未知时 `organizationId()` 抛错，不猜测 `default`。个人版直接采用单组织 `default`；组织列表端点返回 404 的旧部署也采用单组织兼容；返回 401 则视为未登录，其他错误继续抛出。

多组织部署优先采用服务端标记的 active 组织；没有 active 但有成员关系时，先请求将会话移到第一个组织；完全无成员关系则报错。证据：[current](../../app/src/lib/organizations/current.ts)、[ownOrganizations](../../app/src/lib/organizations/queries.ts)。

切换时先更新服务端会话，再离开旧页面，再修改本地组织。查询缓存的 hash 加入当前组织；切换后取消并移除旧组织查询，组织列表和部署信息除外。该实现防止前端复用旧结果，但不是服务端访问控制的替代品。证据：[组织 mutations](../../app/src/lib/organizations/mutations.ts)、[query-client](../../app/src/query-client.ts)。

## 权限不能由显示状态推断

| 问题 | 应依据什么 | 不应依据什么 |
| --- | --- | --- |
| 能否管理 Bot | 服务端 `canManage` | 是否 public、是否 mine |
| 是否本人创建 | `mine` | canManage；管理员也可能可管理别人的 Bot |
| Bot 是否有独立计算机 | `isolationActive` 和关闭原因 | 仅看 isolated 配置 |
| 是否仍持有能力 | 服务端 grants、grantedTo、reachable | 是否在自己的 Bot 列表隐藏 |
| 是否可用某个 App 动作 | Bot Grant，加上可用账户及其他运行限制 | App 已添加或 Connection 已建立 |
| 是否可以免问执行 | 当次审批策略和决定 | 已获得 Bot Grant |

证据：[Bot](../../app/src/lib/api/generated/model/bot.ts)、[grantRoster](../../app/src/lib/agents/grant-roster.ts)、[handoffRoster](../../app/src/lib/agents/handoff-roster.ts)、[BotGrant](../../app/src/lib/api/generated/model/botGrant.ts)。Grant 页面会补回持有相关能力的隐藏 Bot，以保留管理入口；不会因此恢复它在普通列表的显示。

## 共享账户与外部输入

共享账户使用许可将 audience 分成 owner、people、team，并单独记录 outsideInput。把 Bot 变成 public，或添加外部 Goal Trigger，可能改变共享账户需要覆盖的人群和启动来源，不能据此自动认定旧许可足够。

证据：[SharedUseApproval](../../app/src/lib/api/generated/model/sharedUseApproval.ts)、[SharedUseAudience](../../app/src/lib/api/generated/model/sharedUseAudience.ts)、[共享使用查询](../../app/src/lib/plugins/shared-use.ts)、[创建触发器时刷新请求](../../app/src/lib/responsibilities.ts)。

Skill 的 tools 是所需动作声明，不赋予权限；App 返回的 `destructive` 表示提供方声明，不表示 false 时必然安全。证据：[Skill](../../app/src/lib/api/generated/model/skill.ts)、[AppTool](../../app/src/lib/api/generated/model/appTool.ts)。

## 动作审批

| 规则行为 | 契约含义 |
| --- | --- |
| allow | 直接执行 |
| pre_approved | 仅在人的当前请求明确要求该动作时执行 |
| ask | 先询问 |
| hand_off | 交给人完成 |

人的回答可以仅允许一次、当前对话允许、持续允许、拒绝，或确认已亲自完成。来自 Check-in Task 的审批、管理员关闭持续许可的动作和 hand_off 不提供持续许可。证据：[ApprovalRuleBehaviour](../../app/src/lib/api/generated/model/approvalRuleBehaviour.ts)、[ApprovalDecision](../../app/src/lib/api/generated/model/approvalDecision.ts)、[offersStandingRule](../../shared/standing-rule.ts)。

## Harness 和计算机边界

LangGraph harness 的非健康检查请求要求部署提供的 token。它只在当前调用的工具全部属于服务端声明的 deployment tools 时本地执行；不认识的工具或混有前端工具的调用会把控制权交还调用方。执行时再次核对工具归属。运行 assertion 存在请求上下文中，并从进入图状态的属性里剥离。证据：[main](../../agent-langgraph-agui/src/main.py)、[tool_runtime](../../agent-langgraph-agui/src/tool_runtime.py)。该结论针对这个 harness，其他 harness 需各自核验。

计算机 token 使用部署密钥加身份派生：`HMAC-SHA256(key, "openbot computer token v1\n<kind>:<id>")`。源码说明专属计算机使用派生 token，共享计算机是例外；当前仓库能确认派生函数，镜像内各调用点是否一致仍需部署验证。证据：[computerTokenFor](../../shared/computer-token.ts)、[Compose 网络及环境](../../docker-compose.yml)。

Bot 浏览器仅在人持有控制权时录制，录制归该人，结束后撤销本次临时连接；详细约定见 [bot-browser](../../shared/bot-browser.ts)。这些是共享类型和契约说明，实际录制停止与撤销需要联调核验。
