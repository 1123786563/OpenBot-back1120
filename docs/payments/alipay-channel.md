# 支付宝网站支付渠道(#70)

状态:**协议实现与受控边界测试完成;真实商户产品开通、付款、退款与账单闭环未验证**——那些分别归 #63(商户与环境核实)与 #72(真实闭环验收)。本文记录渠道的固定协议路线、模块边界、配置与验证方式。

## 固定协议路线

- 官方 SDK:`alipay-sdk@4.14.0`(精确锁定在 `server/package.json` 与 `bun.lock`),只使用其 `pageExecute`(GET 重定向 URL)。**不使用**已弃用的 `exec()` 流程,也**不使用** v3 REST 路径。
- 服务端七项操作走传统网关 RSA2:请求按官方规则排序签名(排除 `sign` 与空值),响应按 `alipay-sdk@4.14.0` 源码 `getSignStr` 的**原始字节截取规则**验签(从未把响应对象重新序列化后再验签);异步通知验签按官方规则剔除 `sign`、`sign_type` 后排序拼接,并保留 SDK 的"保留 sign_type 重试一次"兼容路径。
- 截取与验签规则在实现时对照锁定版本源码逐一核对:`util.js#sign`(请求签名)、`alipay.js#checkNotifySign/notifyRSACheck`(通知验签)、`alipay.js#getSignStr`(同步响应截取)。`server/src/payments/alipay/signature.ts` 是这三条规则的唯一实现处。

| 能力 | method | 产物 |
| --- | --- | --- |
| 电脑网站支付 | `alipay.trade.page.pay` | `product_code=FAST_INSTANT_TRADE_PAY`,SDK 生成的 GET 收银台 URL |
| 手机网站支付 | `alipay.trade.wap.pay` | `product_code=QUICK_WAP_WAY`,同上 |
| 查单 | `alipay.trade.query` | 渠道状态/交易号/金额/`send_pay_date`(北京→UTC 微秒);`total_amount` 缺失或与期望不符→协议错误,成功状态缺交易号或金额→unknown(保原文),显式非 CNY(`settle_currency`/`currency`)→协议错误 |
| 关单 | `alipay.trade.close` | closed / `ACQ.TRADE_HAS_SUCCESS` 竞争→unknown(交查单裁决);成功回包必须带可绑定本单的 `trade_no` |
| 退款 | `alipay.trade.refund` | 以调用方持久化的 `out_request_no` 幂等;`fund_change=Y` + 可解析且相等的 `refund_fee` + 回显请求号一致才 succeeded;回显单号/交易号不符→协议错误 |
| 退款查询 | `alipay.trade.fastpay.refund.query` | 同一原请求号;succeeded 需要完整证据链(`REFUND_SUCCESS` + 回显请求号 + 交易号 + 可解析且相等的退款金额),缺证据 pending、金额矛盾 unknown |
| 账单地址 | `alipay.data.dataservice.bill.downloadurl.query` | trade 账单 ZIP 下载地址;未生成/过期/暂时失败可区分、可重试 |

## 模块与边界

```
server/src/payments/types.ts            # 渠道无关的生产类型(快照/观察值/退款请求)
server/src/payments/alipay/config.ts    # 配置绑定:全部 ALIPAY_* 一起出现,缺一拒绝启动
server/src/payments/alipay/signature.ts # 三条 RSA2 规则的唯一实现
server/src/payments/alipay/gateway.ts   # 受控 HTTP 边界 + 签名请求 + 原始响应验签 + code/sub_code
server/src/payments/alipay/adapter.ts   # 七项操作;PC/WAP 入口;重定向 URL 超限显式失败
server/src/payments/alipay/notification.ts # 通知解码(一次)、验签、身份、快照匹配、消息身份
server/src/payments/alipay/inbox.ts     # 真实 PostgreSQL 收件箱(见下)
server/src/payments/alipay/statement.ts # 账单下载(HTTPS 白名单/私网拒绝/限长/逐跳)与 ZIP/CSV 解析
server/src/payments/alipay/routes.ts    # POST /payment-callbacks/alipay(text/plain success/failure)
server/src/db/schema/payments.ts        # payment_channel_notification 表(drizzle 迁移 0093)
```

- **生产接线**:`createApp` 在 `config.payments.alipay` 存在时**自行**从共享数据库(`attachmentDatabase`,即部署的 PostgreSQL 实例)构建收件箱并挂载通知路由——生产入口只需传 config 与数据库,不需要显式传 inbox;inbox 参数仅留作测试覆盖(如存储失败注入)。没有数据库也没有显式 inbox 时,路径保持 404,不存在"能答 success 却无落库"的入口。
- 订单、支付尝试、退款、权益、积分账本**不在本渠道内**——分别归 #68/#71 与既有账本。适配器只输出观察值(status、raw_trade_status、交易号、金额分、付款时间、证据来源),未知保持 unknown,从不生成成功事实。
- `payment_channel_notification` 是共享接收层到达前的持久化收件箱:唯一身份 `(channel, app_id, dedupe_key)`,`dedupe_key` 优先 `notify_id`,缺失时用"应用+交易号+状态+业务时间+载荷摘要"合成(同一交易的后续状态是新消息,不会丢)。同身份不同内容落库为 `isolated` 告警。#68 的业务消费者从 `state='inbox'` 认领;本渠道不做业务匹配。
- 回跳 `return_url` 只做导航:白名单(HTTPS 精确 origin)之外不生成收银台链接;回跳参数从不确认付款,确认只走订单查询 API。
- **付款期限绑定订单**:快照已过期(`expires_at_us` 早于当前时刻)不生成任何入口;未过期的快照把订单到期时间以官方绝对截止字段 `time_expire`(北京墙钟,秒精度,亚秒向下取整)签入 PC/WAP 两入口的 biz_content——提前生成的链接在订单过期后无法继续收款。
- 网站模式由显式入口选择(合同 `CreatePaymentAttemptRequest.alipay_website_mode=pc|wap`,仅 `channel=alipay & payment_scenario=h5`;省略默认 `wap`),**不用 UA 判定**。合同补充了支付宝的 `application/x-www-form-urlencoded` 通知体与 `text/plain success/failure` 应答媒体类型。
- **账单完整性**:ZIP 逐条目先按中央目录声明尺寸拒绝超限(解压前),解压用 `maxOutputLength` 独立再限;每条目校验**声明未压缩尺寸一致**与 **CRC-32**——存储位翻转、流截断、目录谎报尺寸都使整个账单失败,不会解析出"没人写过的金额"。下载按流增量计数,超限即中断,不整包读入后再量。解析结果摘要携带**可信商户标识**(app_id/seller_id,取自配置而非账单),不同商户同日账单可独立归属。

## 配置

见 `.env.example` 的 `ALIPAY_*` 段。全部变量一起出现才生效,缺任何一个拒绝启动;`notify_url` 必须 HTTPS;`return_url` 白名单至少一条 HTTPS origin。密钥永不入日志(可打印形态只有 `alipayConfigSummary()` 的身份与限额字段)。

## 已验证(本仓库内,可重复)

```sh
cd OpenBot
bun install --frozen-lockfile
bun run billing:contract:check        # lint + 客户端再生成 + 语义检查(424 checks, 0 failures)
# 需要真实 PostgreSQL(TEST_DATABASE_URL 指向专用库,先 bun server/scripts/migrate.ts):
TEST_DATABASE_URL=postgres://…/openbot_test bun test server/tests/payments/alipay/
```

121 个用例,全部为每次运行新生成的 RSA-2048 材料,无生产密钥:

- 七项操作的**真实生产适配器**打到受控 loopback HTTP 网关,捕获的请求用商户公钥逐个验签;PC/WAP 两入口分别断言 method、`product_code`、金额、`time_expire`(北京墙钟的订单到期)、return/notify URL,且重定向 URL 的签名可在边界验证;过期快照拒绝生成入口。
- 响应篡改(签名有效载荷换一个字节)→ 显式拒绝,不产生观察值;超时 → unknown,不转 failed;查单 `total_amount` 缺失/不符→协议错误,成功状态缺交易号→unknown,非 CNY→协议错误;关单成功缺 `trade_no` 或他单交易号→拒绝。
- **官方验签向量**(`server/tests/payments/alipay/fixtures/official/`,来源与版本见其 README):官方《自行实现验签》文档(02mse7,更新 2026-03-26)的异步通知样例字段与同步响应字节形态(含 `\/` 转义)逐字保留,用运行时密钥按官方规则重签后经生产验签代码核验;重新序列化的响应必须验签失败;官方串与规则输出的差异(文档示例遗漏 4 个参数)已记录并按规则全集处理。
- 通知:一次解码、编码字符、重复字段拒绝、伪签(攻击者私钥)、签名后改金额、外应用/外商户、显式非 CNY 拒绝、缺 `gmt_payment` 保持 null。
- HTTP 入口两条路径都有真实 PostgreSQL 证据:`production-wiring.integration.test.ts` 以生产形态(仅 config + 共享数据库)构造 createApp,证明路由自建收件箱并落库后才答 `success`、伪签不落库;`notify-routes.integration.test.ts` 覆盖重放一行、同 `notify_id` 异内容 `isolated`、乱序两条消息、存储失败 503、无 inbox 404,且每个 notify_id 带运行唯一前缀、清理只删本次前缀行。
- 退款:持久化 `out_request_no` 复用;`fund_change=N`、`refund_fee` 缺失/不可解析与查询成功无退款证据都保持 pending;`REFUND_SUCCESS` 缺金额证据或缺交易号绑定→pending,金额矛盾→unknown,回显单号/交易号/请求号不符→协议错误;同一请求号 + 明确成功 + 完整证据链才 succeeded。
- 账单:ZIP/CSV 官方形态夹具(含 GBK 脱敏官方形态文件);**CRC 翻转、截断 deflate、目录谎报尺寸、解压超限全部整体失败**;路径穿越拒绝;缺列/金额不精确/方向未知/时间不可读→整体失败;摘要携带可信 app_id/seller_id 并绑定原始字节。

## 未验证(诚实边界)

- 真实商户沙箱/生产的付款、退款、账单与回调可达性(#63/#72)。`ACQ.BILL_NOT_EXIST`/`ACQ.BILL_DOWNLOAD_URL_EXPIRED` 等 sub_code 的精确字符串以受控网关夹具验证,真实网关取值在 #72 用真账单核对;官方账单样本的**逐字节真实样本**(商家中心实名下载)未取得,本仓库夹具为按公开格式说明的脱敏重构,真实样本比对在 #72。`time_expire` 在真实收银台的实际截止单位与行为也未实测(受控边界已验证签名与字段)。
- 电脑/手机产品分别开通、域名与回调白名单(#63)。
- `billing:test:guard` 的独立 PostgreSQL 二进制布局(`/workspace/.tools/pg/…`)在本机不可用;本票以 Docker 的真实 PostgreSQL 17.12(pgvector/pgvector:pg17)承载了收件箱集成证据,guard 套件本身仍在 #62 验收记录中。
- 内置浏览器(微信/钉钉内嵌)对 PC/WAP 收银台的兼容性:未证实支持,产品上应提示外部浏览器打开;属 #72 验收时的实测项。

## 证据边界

协议测试与真实商户联调是**两种完成状态**:本票(协议)已完成,商户闭环(#72)未开始。所有测试夹具不含任何真实凭据;带授权的账单下载 URL 也不进入任何证据。
