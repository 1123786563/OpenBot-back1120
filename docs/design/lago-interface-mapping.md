# Lago 接口映射核查

基于本地 lago/api 源码静态检查，尚未运行端到端验证；接口存在不代表完整调用链已验证支持社区版。Lago API 子模块指定提交为 af1b5856563440f4244cab0ebcdaf48710ccecf2。

| 用途 | 已找到接口或字段 | 核查结论与剩余验证 |
| --- | --- | --- |
| 个人计费账户 | POST /api/v1/customers，external_id、timezone | 控制器支持外部 ID 与时区；建议映射稳定的计费账户 ID，尚待确认 |
| 用量归属 | POST /api/v1/subscriptions，external_id、external_customer_id、billing_time、subscription_at、ending_at | 存在订阅关联接口；无付费订阅者的计量关系、月末周期及终止边界需验证 |
| 消费事件 | POST /api/v1/events，transaction_id、code、timestamp、external_subscription_id、properties | CreateService 对重复 transaction_id 返回 value_already_exist；重试不能只凭重复错误认定内容一致，需要关联并核对原事件 |
| 用量查询 | GET /api/v1/customers/:external_id/current_usage | 路由存在；订阅筛选、时区、最终一致性及跨周期迟到事件待验证 |
| 账单查询 | GET /api/v1/invoices 及 /:id | 用于核算；积分单位、人民币销售额、消费估值的映射尚未确定，不能混为同一金额 |
| 登记外部收款 | POST /api/v1/payments | ManualCreateService 对非 advance_charges 账单检查 Premium；首期不能直接依赖此接口完成全部收款同步 |
| 更新账单付款状态 | PUT /api/v1/invoices/:id，payment_status | 控制器及 UpdateService 存在此路径，所检查服务未见 Premium 检查；它不等价于创建完整 Payment 或写入实收金额，且有费用状态、预付积分、订阅激活等副作用，需集成验证 |

源码依据（相对于 lago/api）：config/routes/shared_api.rb；app/controllers/api/v1/{customers,subscriptions,events,invoices,payments}_controller.rb；app/services/events/create_service.rb；app/services/payments/manual_create_service.rb；app/services/invoices/update_service.rb。

后续验证必须覆盖：社区版无许可调用、重复事件、上报超时重试、跨周期迟到事件、价格版本与六位积分精度、付款状态副作用，以及账单不会触发第二次收款。

## 第二轮静态核查

- app/models/event.rb 的唯一索引范围是 organization_id、external_subscription_id、transaction_id；重试必须固定计量关系及事件 ID。其订阅匹配按事件 timestamp 与 started_at/terminated_at 比较。
- app/services/events/create_service.rb 保存原始事件后排队后处理；接收成功不等于聚合完成。app/services/events/post_process_service.rb 按事件时间查找订阅，故历史补传需保留原始时间及关联关系。
- app/services/events/timestamp_window.rb 允许通过 LAGO_EVENTS_MAX_PAST_DAYS 限制历史事件，未设置时该限制关闭。允许接收历史事件不代表已出账周期自动重算，后者仍待验证。
- app/services/charges/create_service.rb 仅在 License.premium? 分支设置 invoiceable。因此社区版方案不能未经验证就依赖 invoiceable=false 来禁用消费账单；零金额计量或其他核算表达仍需验证。
- 上述均为源码检查，未运行数据库、API 或跨周期场景测试。

## 零金额候选配置的后续核查

- StandardService 的金额计算是 units × BigDecimal(properties["amount"])；设置单价字符串 "0" 在该计算路径上产生零金额，而不改变用量单位。尚需验证配置校验及零费用在完整账单链路中是否被保留。
- Customers::ChargeUsageSerializer 分别输出字符串 units、total_aggregated_units 及 amount_cents；结构上可以表达非零用量与零金额，但不能据此认定零费用一定会出现在查询响应。
- Customers::UsageController 的 current 接收 external_subscription_id，past 接收 external_subscription_id、billable_metric_code、periods_count，支持按计量关系查询的候选路径。
- 已检查本地 Docker：Docker 可用，但没有正在运行的 Lago 服务；尚未执行最小 API 场景，不能把上述源码推断记为实测通过。

候选配置：月度零固定费计划，sum_agg 指标，standard 收费模型 properties.amount="0"，不使用 pay_in_advance 收费或社区版不可直接设置的 invoiceable=false。分别归集用户扣分、平台承担用量及用户自付用量；具体指标与事件结构待确认。

最小运行验收：创建隔离测试客户、指标、零价计划及计量关系；提交非零用量，确认 current_usage 返回非零 units 与零 amount_cents；重复提交不重复累计；验证历史时间及月底事件归属；最终账单不得形成非零应收或发起支付。还需验证零费用未被聚合或账单过滤掉，以及六位积分的精确往返。

## 运行验证结果

已在官方 getlago/lago:v1.57.0 的独立临时环境完成最小 API 场景，Premium=false。非零用量 17、整数微积分 1,000,123 在零价格下正常返回；重复事件返回 422 且不增加汇总。终止计量关系生成 finalized CNY 账单，保留用量明细，总额及待付额均为零。详见 [验收结果与证据](billing-acceptance.md)。前文“尚未实测”描述的是各次静态核查当时状态，以本节为最新状态。

时区验收未通过：请求客户 Asia/Shanghai，返回适用时区 UTC。源码客户及组织时区赋值均有 Premium 门控。北京时间周期与 Lago UTC 汇总的映射仍是实现前阻断项，不能据本次零价测试宣称完整周期方案通过。

## 时区映射后续验证

上段为首次零价验证时的状态。后续已按用户决定保留 UTC，以事件级查询实现北京时间周期核对；真实 API 验证月末边界、分页、迟到补传与重复事件通过，详见 [验收结果](billing-acceptance.md) 和 [映射设计](billing-timezone-mapping.md)。GET events 的 timestamp_from/to 均包含端点，适配层必须执行半开区间过滤。

已出账 UTC 二月用量为 15，迟到事件成功处理后原始用量为 32，而观察到的旧账单仍为 15。故对账依赖原事件与追加调整，不依赖旧账单自动重算。社区版时区限制已由该架构规避，无需绕过许可；生产级并发、亚秒精度和调整持久化仍未验收。

后续已实测 PostgreSQL 社区版并发补传与时间精度：分页漂移可通过全窗口重扫、稳定 ID 去重及预期集合核对恢复；4 对并发重复事件均只保存一次。数据库/过滤保留微秒，但响应 timestamp 仅保留毫秒，不能直接用于精确周期归属。适配层改用经本地校验的 properties.occurrence_us，粗筛扩大范围、最终整数半开过滤；该路径已通过 1 微秒窗口测试。详见 [最新验收结果](billing-acceptance.md)，生产重扫持久化和账本集成尚未实现。
