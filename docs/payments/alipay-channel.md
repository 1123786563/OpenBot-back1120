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
| 查单 | `alipay.trade.query` | 渠道状态/交易号/金额/`send_pay_date`(北京→UTC 微秒) |
| 关单 | `alipay.trade.close` | closed / `ACQ.TRADE_HAS_SUCCESS` 竞争→unknown(交查单裁决) |
| 退款 | `alipay.trade.refund` | 以调用方持久化的 `out_request_no` 幂等;`fund_change=Y` 且金额一致才算成功 |
| 退款查询 | `alipay.trade.fastpay.refund.query` | 同一原请求号;仅 `refund_status=REFUND_SUCCESS` 为到账证据 |
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

- 订单、支付尝试、退款、权益、积分账本**不在本渠道内**——分别归 #68/#71 与既有账本。适配器只输出观察值(status、raw_trade_status、交易号、金额分、付款时间、证据来源),未知保持 unknown,从不生成成功事实。
- `payment_channel_notification` 是共享接收层到达前的持久化收件箱:唯一身份 `(channel, app_id, dedupe_key)`,`dedupe_key` 优先 `notify_id`,缺失时用"应用+交易号+状态+业务时间+载荷摘要"合成(同一交易的后续状态是新消息,不会丢)。同身份不同内容落库为 `isolated` 告警。#68 的业务消费者从 `state='inbox'` 认领;本渠道不做业务匹配。
- 回跳 `return_url` 只做导航:白名单(HTTPS 精确 origin)之外不生成收银台链接;回跳参数从不确认付款,确认只走订单查询 API。
- 网站模式由显式入口选择(合同 `CreatePaymentAttemptRequest.alipay_website_mode=pc|wap`,仅 `channel=alipay & payment_scenario=h5`;省略默认 `wap`),**不用 UA 判定**。合同补充了支付宝的 `application/x-www-form-urlencoded` 通知体与 `text/plain success/failure` 应答媒体类型。

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

92 个用例,全部为每次运行新生成的 RSA-2048 材料,无生产密钥:

- 七项操作的**真实生产适配器**打到受控 loopback HTTP 网关,捕获的请求用商户公钥逐个验签;PC/WAP 两入口分别断言 method、`product_code`、金额、return/notify URL,且重定向 URL 的签名可在边界验证。
- 响应篡改(签名有效载荷换一个字节)→ 显式拒绝,不产生观察值;超时 → unknown,不转 failed。
- 通知:一次解码、编码字符、重复字段拒绝、伪签(攻击者私钥)、签名后改金额、外应用/外商户、显式非 CNY 拒绝、缺 `gmt_payment` 保持 null。
- HTTP 入口(createApp + 真实 PostgreSQL 收件箱):`success` 仅在落库提交后;重放同内容再次 `success` 只存一行;同 `notify_id` 异内容落 `isolated`;丢通知/乱序是两条消息;存储失败 503 `failure`;无 inbox 时路由根本不挂载(404)。
- 退款:持久化 `out_request_no` 复用;`fund_change=N` 与查询成功无退款证据都保持 pending;金额不符保持 unknown;同一请求号 + 明确成功 + 金额一致才 succeeded。
- 账单:ZIP/CSV 官方形态夹具;路径穿越拒绝;缺列/金额不精确/方向未知/时间不可读→**整体失败**,不返回部分成功;摘要绑定原始字节。

## 未验证(诚实边界)

- 真实商户沙箱/生产的付款、退款、账单与回调可达性(#63/#72)。`ACQ.BILL_NOT_EXIST`/`ACQ.BILL_DOWNLOAD_URL_EXPIRED` 等 sub_code 的精确字符串以受控网关夹具验证,真实网关取值在 #72 用真账单核对;官方账单样本的表头/编码(GBK)以本仓库夹具与 TextDecoder 路径验证,真实样本比对在 #72。
- 电脑/手机产品分别开通、域名与回调白名单(#63)。
- `billing:test:guard` 的独立 PostgreSQL 二进制布局(`/workspace/.tools/pg/…`)在本机不可用;本票以 Docker 的真实 PostgreSQL 17.12(pgvector/pgvector:pg17)承载了收件箱集成证据,guard 套件本身仍在 #62 验收记录中。
- 内置浏览器(微信/钉钉内嵌)对 PC/WAP 收银台的兼容性:未证实支持,产品上应提示外部浏览器打开;属 #72 验收时的实测项。

## 证据边界

协议测试与真实商户联调是**两种完成状态**:本票(协议)已完成,商户闭环(#72)未开始。所有测试夹具不含任何真实凭据;带授权的账单下载 URL 也不进入任何证据。
