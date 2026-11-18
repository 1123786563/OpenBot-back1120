# T02 / #63 双渠道商户环境：协议冻结表与受控配置模板

Part of #61 / #63。本文件只承载两类可复用的非敏感交付物：

1. 官方协议与 SDK 冻结表（供 #69/#70 适配器实施者直接引用）；
2. 非敏感受控配置模板 `PaymentEnvironmentConfig`（供 #69/#70 配置加载器消费）。

本文件**不**包含：支付适配器实现、配置加载器实现、任何真实商户身份、密钥或证书正文。
商户后台核查（AC1/AC6）、密钥注入与加载实测（AC2/AC4）、公网 HTTPS 回调探针（AC3）、
真机浏览器矩阵（AC5）与消费方签收（AC7）均属外部实测，未执行时 #63 保持未完成，
本文件的存在不解除任何外部阻塞。

核查环境与方法：公开官方文档只读核查（web 抓取 + URL 记录），核查日期 2026-11-18；
网关 TLS 探针在本地开发机执行（经代理网络路径，见 §4）。全程未使用任何凭据、
未访问商户后台、未发起任何支付/退款/下单。

## 1. 微信支付 APIv3 冻结表

核查方式：只读公开官方页面（现行文档站 `pay.weixin.qq.com/doc/v3/merchant/{ID}`，
官方提供 `llms.txt` 索引；官方 GitHub org `wechatpay-apiv3`）。核查日期 **2026-11-18**，
逐页标注的官方更新时间见 URL 列。全程未使用商户凭据。

### 1.1 接口映射（能力 → 方法/路径）

| 能力 | 方法/路径 | 关键约束（官方原文要点） | 官方 URL（更新时间） |
| --- | --- | --- | --- |
| Native 下单 | `POST https://api.mch.weixin.qq.com/v3/pay/transactions/native`（备 `api2.mch.weixin.qq.com`） | 必填 `appid/mchid/description/out_trade_no/notify_url/amount.total`（分）；`out_trade_no` 6–32 字符；应答 `code_url` **有效期 2 小时** | [4012791877](https://pay.weixin.qq.com/doc/v3/merchant/4012791877)（2025.03.31） |
| 查单（商户单号） | `GET /v3/pay/transactions/out-trade-no/{out_trade_no}?mchid=` | 应答 `trade_state`（SUCCESS/REFUND/NOTPAY/CLOSED/…） | [4012791880](https://pay.weixin.qq.com/doc/v3/merchant/4012791880)（2024.12.27） |
| 查单（微信单号） | `GET /v3/pay/transactions/id/{transaction_id}?mchid={mchid}` | **`mchid` 是必填 query 参数**（2026-11-18 第二轮更正，此前遗漏）：官方 Go SDK `QueryOrderById` 缺 `mchid` 时直接报错 `field Mchid is required`，并在构造请求时将其加入查询串（[api_native.go](https://github.com/wechatpay-apiv3/wechatpay-go/blob/main/services/payments/native/api_native.go)，`QueryOrderById`/`QueryOrderByOutTradeNo` 两方法一致）。#69 实现时**签名覆盖的 URL 目标必须与请求目标一致（含 query string）**，并覆盖"缺 mchid → 本地拒绝"测试用例（见 §5 V-R6） | [4012791879](https://pay.weixin.qq.com/doc/v3/merchant/4012791879) |
| 关单 | `POST /v3/pay/transactions/out-trade-no/{out_trade_no}/close`，body 必填 `mchid` | 应答 **204，无包体** | [4012791881](https://pay.weixin.qq.com/doc/v3/merchant/4012791881)（2024.12.11） |
| H5 下单 | `POST /v3/pay/transactions/h5` | **`scene_info` 必填**：`payer_client_ip`、`h5_info.type`（Wap/iOS/Android）；应答 `h5_url` **有效期 5 分钟**，禁缓存、禁拆改，仅可追加 `redirect_url`；`time_expire` 上限 15 天（Native 7 天） | [4012791834](https://pay.weixin.qq.com/doc/v3/merchant/4012791834)（2025.03.31） |
| 退款 | `POST /v3/refund/domestic/refunds` | `transaction_id`/`out_trade_no` 二选一；`out_refund_no` 必填且重试必须用原单号；最多 50 笔部分退款；返回成功仅代表受理 | [4012791883](https://pay.weixin.qq.com/doc/v3/merchant/4012791883)（2025.01.09） |
| 退款查询 | `GET /v3/refund/domestic/refunds/{out_refund_no}` | `status`: SUCCESS/CLOSED/PROCESSING/ABNORMAL | [4012791884](https://pay.weixin.qq.com/doc/v3/merchant/4012791884)（2025.01.09） |
| 交易账单 | `GET /v3/bill/tradebill` → `GET {download_url}` | `download_url` 5 分钟有效；SHA1 `hash_value` 校验 | [4012791887](https://pay.weixin.qq.com/doc/v3/merchant/4012791887)（2025.01.10） |
| 资金账单 | `GET /v3/bill/fundflowbill` → 同上下载流程 | — | [4012791888](https://pay.weixin.qq.com/doc/v3/merchant/4012791888)（2025.01.09） |
| 支付/退款通知 | 渠道 → 商户 `notify_url` | 验签头四件套 `Wechatpay-Timestamp/Nonce/Signature/Serial`；验签串 `时间戳\n随机串\n报文主体\n`（含尾行）；5 秒内验签；失败按 15s→…→6h 最多 15 次重试 | [4012791882](https://pay.weixin.qq.com/doc/v3/merchant/4012791882)（2024.12.27）、[4012791886](https://pay.weixin.qq.com/doc/v3/merchant/4012791886) |

**⚠ 回调应答格式更正（覆盖现有合同注释）**：现行官方文档要求验签通过返回
**HTTP 200 或 204、无应答包体**；失败才返回 4XX/5XX + `{"code":"FAIL","message":…}`。
`{"code":"SUCCESS"}` 是旧版文档惯例，**未在现行官方页面核实到**。#62 合同
`contracts/billing/schemas/channel.yaml` 中 WeChat ack 示例需在 #69/#70 落地时按
现行规范修正（外层 ack 仍按合同统一 JSON 常量映射到协议线格式）。

**通知解密**：`resource.ciphertext`（Base64）用 **APIv3 key（32 字节）** 做
AES-256-GCM（`AEAD_AES_256_GCM`，nonce 12 字节，`associated_data` 可空，tag 128 bit）
解密；APIv3 key 仅用于解密，**不得用于验签**
（[4012071382](https://pay.weixin.qq.com/doc/v3/merchant/4012071382)、易错点 4054257711）。
官方还发送 `Wechatpay-Signature` 以 `WECHATPAY/SIGNTEST/` 开头的探针流量检验商户是否真验签。

### 1.2 验签材料与轮换

- **默认模式：微信支付公钥**。官方现行页明确推荐（平台证书介绍页首句，2026.05.20）：
  平台证书 5 年有效期易过期，公钥"一次申请永久有效"。公钥 ID 前缀 `PUB_KEY_ID_`。
  验签材料从商户平台后台（账户中心→API 安全）人工下载，**官方无公钥下载/轮换 API**，
  以静态受控配置注入（对应 §3 `wechat.verification_mode=public_key`）。
- **兼容分支：平台证书**。`GET /v3/certificates`（限频 1000 QPS）返回
  `serial_no/effective_time/expire_time/encrypt_certificate`，证书内容用 APIv3 key
  AES-256-GCM 解密；官方要求**定期调用（间隔 < 12 小时）**，不硬编码；换证书前
  24 小时同时返回新老两张；`serial_no` 与回调头 `Wechatpay-Serial` 匹配。
- **判定规则**（官方 4012791882）：回调头 `Wechatpay-Serial` 为 `PUB_KEY_ID_*` → 用
  公钥验签；否则用平台证书。灰度期间两模式随机出现，**必须双模式兼容**；未知 Serial
  一律验签失败，不跳过。配置侧该迁移态由 §3 `wechat.verification_mode=migration_dual`
  表达（两套材料来源、按 Serial 路由、初始化/刷新与退出条件见 §3；接受/拒绝用例见
  §5.1 V-R10/V-R11）。
- 公钥模式切换按商户号维度、需在商户平台手动开启；"2024-10 起新商户强制公钥"为
  第三方信息，官方现行页面未核实到，仅作背景。

### 1.3 SDK 决策

- 官方 APIv3 服务端 SDK 仅 **Java（wechatpay-java）/ PHP（wechatpay-php）/
  Go（wechatpay-go）**，org `github.com/wechatpay-apiv3`；官方 SDK 概述页
  （[4012076498](https://pay.weixin.qq.com/doc/v3/merchant/4012076498)，2026.04.24）注明
  **服务端 SDK 已停止更新维护，建议参考 WXPayUtility 工具类（Java/Go）实现接入**。
- **不存在官方 Node.js/JavaScript/TypeScript SDK**（org 9 个仓库中无 JS SDK）；
  npm 的 `wechatpay-node-v3`、`wechatpay-axios-plugin` 等为社区 SDK，不得标为官方。
- **OpenBot 冻结决策（Bun/TS 运行时）**：采用**直接协议实现**（Node/Bun 内置
  crypto 完成 SHA256-RSA 签名/验签与 AES-256-GCM 解密），以官方协议页为唯一依据、
  WXPayUtility（Java/Go）为参考实现；不引入任何第三方"微信 SDK"包。
  依赖锁文件在 #69 落地时以精确版本提交（本票不写适配器，不预填版本号）。

### 1.4 产品开通前提（AC1 核查清单的官方口径）

| 产品 | 主体/应用要求 | 网站要求 | 官方 URL |
| --- | --- | --- | --- |
| Native | 个体工商户/企业/事业单位/政府机关/社会组织；已认证服务号、政府/媒体公众号、小程序或移动应用 | PC 网站域名需 **ICP 备案**；异主体需盖章授权函；商户平台→产品中心→Native 支付→开通（约 7 个工作日） | [4012791874](https://pay.weixin.qq.com/doc/v3/merchant/4012791874)、[4012791875](https://pay.weixin.qq.com/doc/v3/merchant/4012791875) |
| H5 | **不含个体工商户**（与 Native 不同）；应用要求同上 | 支付域名 ≤5 个，须公网可访问并有经营内容；需 **ICP 备案截图**（beian.miit.gov.cn 查询）；异主体仅限同集团/品牌-经销商/SaaS 三种关系并出证明 | [4012791832](https://pay.weixin.qq.com/doc/v3/merchant/4012791832)、[4012791841](https://pay.weixin.qq.com/doc/v3/merchant/4012791841)、域名配置 [4013287193](https://pay.weixin.qq.com/doc/v3/merchant/4013287193)（2026.09.18） |
| 回调 | `notify_url` 要求外网可访问；官方要求商户防火墙对微信回调 IP 段开白名单 | "回调域必须备案"未在官方页面核实到 → **官方未明确**，AC1 时由商户管理员在后台确认 | [4012075420](https://pay.weixin.qq.com/doc/v3/merchant/4012075420) |

以上均为官方产品页口径，**不构成本商户已开通的证据**；AC1 仍需商户管理员在
真实商户后台逐项核查（本票未解除该阻塞）。

## 2. 支付宝接口族冻结表

核查方式：只读公开官方页面（opendocs.alipay.com，含官方 llms.txt/.md 接口）、
npm registry / Maven Central / GitHub `alipay` 官方 org。核查日期 **2026-11-18**。
全程未使用商户凭据、未访问商户后台。

### 2.1 接口族选型（唯一选定：传统网关接口族 gateway.do；2026-11-18 第二轮更正选型依据）

事实核查结论（官方来源）：

- **v3 REST 已覆盖**电脑网站/手机网站支付全部所需能力（下单跳转/查单/关单/退款/
  退款查询/账单下载均有 open-v3 官方页，如 [wap.pay v3](https://opendocs.alipay.com/open-v3/1a957be0_alipay.trade.wap.pay)、
  [page.pay v3](https://opendocs.alipay.com/open-v3/2423fad5_alipay.trade.page.pay)；v3 基本原则
  [054oog](https://opendocs.alipay.com/open-v3/054oog) 明确正式接入点 `https://openapi.alipay.com`）；
  **但 v3 各接口的精确 REST 路径文本未在官方页面核实到**（官方页只给 SDK 示例）。
- **官方 Node.js SDK v4.14.0 同时支持两族协议**（README，[v4.14.0 tag](https://github.com/alipay/alipay-sdk-nodejs-all/releases/tag/v4.14.0)、
  [README 原文](https://raw.githubusercontent.com/alipay/alipay-sdk-nodejs-all/v4.14.0/README.md)，2026-11-18 核查）：
  - SDK"基于支付宝 API v3 接口规范实现"；`curl(httpMethod, path, options)` 调用
    **API v3 REST** 接口（README 示例 `POST /v3/alipay/trade/pay`），非弃用方法；
  - `pageExecute(method, httpMethod, bizParams)` 生成**网站支付（gateway.do 传统族）**
    跳转 URL / POST 表单 HTML，README 示例即 `alipay.trade.page.pay`，**非弃用方法**；
  - `sdkExecute(method, bizParams)` 生成客户端调用串（App 支付等场景）；
  - `exec(method, bizParams)` 传统族服务端调用，**官方已标注 deprecated**：
    "为了让 alipay-sdk@3 尽量平滑升级到 alipay-sdk@4 保留，请尽快使用 alipaySdk.curl()
    代替，走 API v3 协议"。
  - ⚠ **更正**：上一版冻结表"官方 Node SDK 只支持传统网关协议、不支持 v3，且方法名为
    `execute`"的表述**有误**（v4.14.0 支持 v3，服务端传统方法名为 `exec` 且已弃用），
    本节为更正后的依据，以此为准。

**冻结决策**：OpenBot（Bun/TS）仍选定**传统网关接口族**，
网关 `https://openapi.alipay.com/gateway.do`（沙箱
`https://openapi-sandbox.dl.alipaydev.com/gateway.do`），全链路不与 v3 REST 路径混拼。
更正后的选型依据（不再是"SDK 不支持 v3"）：

1. 传统族全部七类能力的 method、参数与返回契约均有已核实的官方文档页（§2.2），
   可完整冻结；而 v3 的精确 REST 路径在官方页面无文本可核实（仅 SDK 示例），
   不满足本票"经核实的接口族/路径"要求；
2. 本票所需电脑/手机网站支付为**跳转形态**，SDK 对应方法 `pageExecute` 为现行
   （未弃用）方法；"v3 能力缺失"这一旧前提经核查不成立，已从依据中剔除。

**该选择依赖的已核实能力与明确代价（不得隐去）**：

- 传统族**服务端调用**（查单/关单/退款/退款查询/账单下载五类）经 SDK 只能走
  `exec()`（deprecated）。#69 落地时二选一并记录在案：
  (a) 锁死 `alipay-sdk@4.14.0` 使用 deprecated `exec()`（接受未来 SDK major 移除该
  方法时升级被阻断的风险）；或
  (b) 这五类按 §2.3 官方 RSA2 规则**直接协议**实现，SDK 仅用于 `pageExecute` 与
  通知验签（`checkNotifySign`/`checkNotifySignV2`）。
- 无论 (a)/(b)，**Bun 运行时兼容性与通知验签实测均为待办**（§2.4），实测不通过则
  整族回退为按官方文档直接协议实现；
- 若后续决定改走 v3 直连，须按官方页面补核 v3 精确 REST 路径并**重冻结**，
  不得在实现中两族混拼。

### 2.2 能力 → method 映射（传统族，官方 URL 已核实）

| 能力 | method | product_code / 备注 | 官方 URL（页面更新时间） |
| --- | --- | --- | --- |
| 电脑网站支付下单（跳转） | `alipay.trade.page.pay` | `FAST_INSTANT_TRADE_PAY`；服务端 `pageExecute` 取 body 作跳转页 | [59da99d0](https://opendocs.alipay.com/open/59da99d0_alipay.trade.page.pay)（2026-09-13） |
| 手机网站支付下单（跳转） | `alipay.trade.wap.pay` | `QUICK_WAP_WAY`；含 `quit_url` | [29ae8cb6](https://opendocs.alipay.com/open/29ae8cb6_alipay.trade.wap.pay)（2026-09-13） |
| 主动查单 | `alipay.trade.query` | — | [4e2d51d1](https://opendocs.alipay.com/open/4e2d51d1_alipay.trade.query) |
| 关单 | `alipay.trade.close` | — | [a62e8677](https://opendocs.alipay.com/open/a62e8677_alipay.trade.close) |
| 退款 | `alipay.trade.refund` | — | [4b7cc5db](https://opendocs.alipay.com/open/4b7cc5db_alipay.trade.refund) |
| 退款查询 | `alipay.trade.fastpay.refund.query` | — | [7be83133](https://opendocs.alipay.com/open/7be83133_alipay.trade.fastpay.refund.query) |
| 对账单下载 | `alipay.data.dataservice.bill.downloadurl.query` | 返回离线账单下载地址；日账单最早近 6 年 | [246b343a](https://opendocs.alipay.com/open/246b343a_alipay.data.dataservice.bill.downloadurl.query)（2026-11-10） |

### 2.3 签名、验签与通知

- **请求签名**：RSA2 = SHA256WithRSA，密钥 ≥2048 位（新应用仅支持 RSA2）；
  待签名串剔除 `sign`/空值/字节流后按参数名 ASCII 升序 `key=value&…`
  （[自行实现签名](https://opendocs.alipay.com/common/057k53)、[02khjm](https://opendocs.alipay.com/common/02khjm)）。
- **加签模式**：密钥模式（应用私钥/应用公钥/支付宝公钥）与证书模式（另含应用证书、
  支付宝公钥证书、根证书）；"一个应用只能配置一种加签方式"；电脑/手机网站支付两种
  皆可、无强制证书（[02kf5p](https://opendocs.alipay.com/common/02kf5p)）。
  **冻结默认：密钥模式**（对应 §3 `alipay.verification_mode=public_key`），
  证书模式作为若商户账号已配证书时的分支（需 `app_cert_sn`/`alipay_root_cert_sn`
  参与签名、按 `alipay_cert_sn` 匹配证书验签，见 [02mse7](https://opendocs.alipay.com/common/02mse7)）。

#### 2.3.1 两种模式下的信任材料角色（2026-11-18 第二轮补充；对应 §3 有类型引用）

与官方 SDK v4.14.0 初始化参数（`AlipaySdkConfig`：`alipayPublicKey` /
`appCertPath|appCertContent|appCertSn` / `alipayPublicCertPath|...|alipayCertSn` /
`alipayRootCertPath|...|alipayRootCertSn`）逐一对应：

| 模式 | 材料角色 | 请求签名用 | 通知/应答验签用 | 备注 |
| --- | --- | --- | --- | --- |
| 密钥模式（public_key，默认） | 应用私钥 | ✔ | — | `key_type` 须显式 PKCS1/PKCS8 |
| 同上 | 支付宝公钥 | — | ✔（验签唯一材料） | 开放平台"接口加签方式"页获取 |
| 同上 | 应用公钥 | — | — | 仅上传开放平台配置，服务端不持有 |
| 证书模式（certificate，分支） | 应用私钥 | ✔ | — | 同上 |
| 同上 | 应用公钥证书 | ✔（计算 `app_cert_sn`，随请求上送 `app_cert_sn`/`alipay_root_cert_sn`） | — | 缺失则请求被网关拒 |
| 同上 | 支付宝公钥证书 | — | ✔（按应答/通知携带的 `alipay_cert_sn` 匹配证书后验签；未知 `alipay_cert_sn` → 验签失败，不跳过） | |
| 同上 | 支付宝根证书 | ✔（计算 `alipay_root_cert_sn`） | — | |

#### 2.3.2 加签模式切换与换钥顺序（流程定义；真实切换实测待授权后由安全/商户管理员回填）

前置约束："一个应用只能配置一种加签方式"（官方 02kf5p），模式切换在开放平台侧完成；
服务端配置切换必须与之协同，不得在运行态同时存在两套可用签名材料参与**请求签名**。

1. **准备**：生成/获取新材料，按 §2.3.1 确定模式，注入密钥管理服务，生成新配置版本
   `config_revision=N+1`（此时不启用）；在候选加载入口对新材料执行自检用例
   （可信签名、篡改拒绝、未知 serial/sn 拒绝、无权限身份拒绝）；
2. **平台侧变更**：商户管理员在开放平台提交模式/公钥变更；变更生效时刻起，新通知按
   新材料签名、旧材料签名的通知仍可能到达（重发队列）；
3. **原子切换**：加载器以 `config_revision=N+1` 原子覆盖运行态；**切换窗口内保留旧
   验签材料只读副本**（有类型对象 `alipay.previous_verification_material`，含旧材料
   模式、所属 `config_revision`、公钥标识或证书 sn 引用、生效与撤销时刻，见 §3），
   旧签名通知在窗口内按 §2.3.3 材料选择规则验证并正常业务处理；窗口结束（含待处理
   重发已过期，如 §2.3 通知重发序列末次 15h 后）撤销旧材料；
4. **切换失败处置**：
   - 新材料自检失败或加载失败：不切换，保持 `config_revision=N` 运行并告警；
   - **平台已变更、本地未激活**（本地仍以旧材料发起主动请求，网关持续返回签名校验
     失败类错误）：停止对该渠道的主动请求重试并告警，**不得**用未通过自检的新材料
     自动顶替，等待人工按本节顺序处置（用例 V-R14）；
   - **回滚前提（须核实平台仍接受旧版本）**：回退到上一 `config_revision` 仅在取得
     下列证据之一后执行：(a) 开放平台后台显示加签方式仍为旧模式/旧公钥（平台变更
     未生效）；或 (b) 以旧材料对真实网关完成一次无资金变更调用（如查单）成功、且
     新材料调用被网关签名校验拒绝。仅"本地旧材料未过期"不构成回滚依据；
     **泄露/过期材料禁止回退使用**；
5. **切换前后验证步骤**：切换前记录第 1 步自检结果；切换后立即以真实网关发起一次
   无资金变更的配置验证调用并核对通知验签路径命中新材料；结果由安全/商户管理员
   实测回填——**本节是流程定义，不是实测证据**。

#### 2.3.3 切换窗口内通知验签材料选择（含无序列号情形；2026-11-18 第三轮补充）

切换/换钥窗口内（`alipay.previous_verification_material != null` 且未过 `not_after`），
入站通知按下列规则选择验签材料：

1. **通知携带 `alipay_cert_sn`**（证书模式签名）→ 以 sn 精确匹配当前模式证书或
   `previous_verification_material` 证书；两者均无匹配 → 验签失败，不跳过；
2. **通知不携带 `alipay_cert_sn`**（密钥模式签名，无序列号可路由）→ **仅在窗口内**
   允许以当前模式材料与 previous 材料依序尝试验签（previous 材料须与当前 `app_id`
   同应用，加载时校验，见 §3）；窗口外或两套均失败 → 验签失败，不确认到账；
3. **待验证保留**：平台过渡期对积压通知重发时使用新旧哪种材料签名，官方页面无明文
   条款，本票保留**待验证**状态（AC4 实测回填）；实现不得假设重发只用其中一种，
   两种签名的通知都须能按上述规则处理。

- **异步通知验签**：剔除 `sign`/`sign_type` → 其余参数 URLDecode → 字典序拼串 →
  `sign` Base64 解码 → 用支付宝公钥 RSA 验签；验签通过后**必须二次校验
  `out_trade_no`/`total_amount`/`seller_id`/`app_id`**（[02mse7](https://opendocs.alipay.com/common/02mse7)）。
- **通知应答**：成功应答为**纯文本 `success`**（HTTP 200）；非 `success` 触发重发
  （立即 3 次，后按 4m/10m/10m/1h/2h/6h/15h）；`notify_url` 无空格/HTML 标签、
  不能重定向（[异步通知说明](https://opendocs.alipay.com/open/194/103296)，2026-08-06）。
- **同步回跳 `return_url`**：GET 回跳附带同步参数；官方明确"前台回跳不可靠，
  支付结果必须以异步通知或查询接口为准，不能依赖同步跳转"
  （[00iki4](https://opendocs.alipay.com/open/00iki4)、接入指南 open/270/105899、open/203/105285）——
  回跳绝不作为到账依据，与父合同一致。
- `notify_url`/`return_url` 均为**接口入参**（每单可传），不需在开放平台预配置；
  "应用网关"是另一回事且可选项，与本票回调无关（[02qibh](https://opendocs.alipay.com/common/02qibh)）。
- **notify_url 是否强制 HTTPS：官方无明文条款**（示例中甚至出现 http）；本票仍冻结
  为 HTTPS，但不得声称"官方强制"。AC3 按父合同要求以 HTTPS 验证为准。

### 2.4 SDK 决策

- **官方 Node.js SDK 存在**：npm `alipay-sdk`，仓库 `github.com/alipay/alipay-sdk-nodejs-all`
  （官方 org `alipay`），**latest 精确版本 `4.14.0`**（2025-04-29 发布；TypeScript 实现；
  engines `node >= 18`，README 要求 `>= 18.20.0`；CJS+ESM 双格式；依赖 urllib 等
  Node 生态）。官方五语言 SDK 清单见 [02n6z6](https://opendocs.alipay.com/common/02n6z6)（2026-03-26）。
- **v4.14.0 公开方法清单**（README 核查，2026-11-18；与 §2.1 选型依据一致）：
  `curl()`（v3 REST）、`pageExecute()`（传统族网页支付跳转，现行）、
  `sdkExecute()`（客户端调用串）、`exec()`（传统族服务端，**deprecated**）、
  `checkNotifySign()` / `checkNotifySignV2()`（异步通知验签，V2 不对 value 做
  decode，官方注明用于规避 [issue #45](https://github.com/alipay/alipay-sdk-nodejs-all/issues/45)
  常见问题）、`aesDecrypt()` / `rsaCheck()`。初始化可指定 `keyType: 'PKCS1'`
  （默认）或 `'PKCS8'`——**官方密钥工具默认生成格式与 SDK 默认解析格式不一致**，
  配置必须显式固定 `key_type`（已纳入 §3 模板）。
- **Bun 兼容性：官方零提及，未知**。#69 落地时须以精确版本 `4.14.0` 在 Bun 实测
  （含 `pageExecute` 与通知验签 `checkNotifySignV2`）；若不兼容，回退方案是按
  §2.3 官方文档直接协议实现（RSA2 签名/验签逻辑已具备官方口径），同样不混用接口族。
- 注意：该包自 2025-04-29 起无更新（npm 与 GitHub 一致，已核实事实）；npm 生态
  其他支付宝包一律视为第三方，不得标为官方。锁文件在 #69 落地时提交。

### 2.5 产品开通前提与沙箱边界（AC1/AC6 核查清单的官方口径）

| 项 | 官方口径 | 官方 URL |
| --- | --- | --- |
| 适用账号 | 企业 / 个人 / 个体工商户均可 | [105898](https://opendocs.alipay.com/open/270/105898)、[105288](https://opendocs.alipay.com/open/203/105288)（2026-08-06） |
| 网站硬性要求 | 可正常访问、经营内容完整；**必须 ICP 备案且备案主体与支付宝账号主体一致**（不一致需授权函） | 同上 |
| 费率/结算 | 电脑网站 0.6%；手机网站 0.6%–1.0%；退款期 12 个月原路退回；新签约 90 日内/连续交易 30 日内次日结算 | 同上 |
| 沙箱 | 新版沙箱可用：网关 `https://openapi-sandbox.dl.alipaydev.com/gateway.do`；**电脑网站支付沙箱仅支持余额支付**；须用沙箱买家账号；官方明文"沙箱调通后必须在线上测试与验收，一切以线上为准" | [105899](https://opendocs.alipay.com/open/270/105899)、[097l48](https://opendocs.alipay.com/common/097l48) |

**沙箱能证明**：签名/验签流程、调用链路、参数正确性（独立 appid/密钥/网关）。
**沙箱不能证明**（官方明文推导）：生产密钥/证书配置正确性、真实资金流与真实支付
渠道行为（仅余额）、线上返回码与业务逻辑。即沙箱通过不构成 AC1/AC6 证据。

以上均为官方产品页口径，**不构成本商户已开通的证据**；AC1/AC6 仍需商户管理员在
真实商户后台逐项核查（本票未解除该阻塞）。

## 3. 受控配置模板（非敏感）

结构 `PaymentEnvironmentConfig` 与上游设计一致。**所有 `*_ref` 字段是受控资源引用
（密钥管理服务路径 / 受限挂载文件名 / KMS key id），不是凭据正文**；真实值只通过
授权密钥管理服务或受限只读挂载注入，加载入口由 #69/#70 交付。以下模板可作为该
加载器的解析目标契约草稿，键名在消费者复核（AC7）后冻结。

```jsonc
{
  "schema_version": "1",
  "config_revision": "<部署时分配的配置版本>",
  "environment_kind": "local_stub | official_sandbox | real_merchant",
  "deployment_revision": "<目标部署 revision/镜像身份>",
  "service_identity": "<运行服务身份>",
  "sales_enabled": false,
  "allowed_products": { "wechat": [], "alipay": [] },   // 仅列验收通过的产品
  "wechat": {
    "merchant_id_ref": "kms://wechat/mchid",
    "app_id_ref": "kms://wechat/appid",
    "signing_private_key_ref": "kms://wechat/apiv3-client-private-key",
    "merchant_certificate_serial_ref": "kms://wechat/cert-serial",
    "api_v3_key_ref": "kms://wechat/api-v3-key",
    "verification_mode": "public_key | platform_certificate | migration_dual",
    // public_key（单模式或主模式）必填（ID 前缀 PUB_KEY_ID_）：
    "platform_public_key_ref": "kms://wechat/platform-public-key",
    "platform_public_key_id_ref": "kms://wechat/platform-public-key-id",
    // platform_certificate 单模式无静态 ref：证书经 GET /v3/certificates 定期刷新（<12h），
    // 解密用 api_v3_key_ref；public_key 与 platform_certificate 两个单模式互斥，
    // 非当前模式字段必须缺省；
    // migration_dual（灰度迁移态，双模式兼容见 §1.2）必填以下字段，
    // 且 secondary_mode != primary_mode：
    "primary_mode": "public_key | platform_certificate",
    "secondary_mode": "public_key | platform_certificate",
    // secondary_mode=public_key 时必填（如主模式为平台证书、迁往公钥的灰度方向）：
    "secondary_platform_public_key_ref": "kms://wechat/secondary-platform-public-key",
    "secondary_platform_public_key_id_ref": "kms://wechat/secondary-platform-public-key-id",
    // secondary_mode=platform_certificate 时无独立静态 ref：与主模式共用同一
    // GET /v3/certificates 刷新缓存（官方换证书前 24h 同时返回新老两张，缓存按
    // serial_no 全量保留，两套证书均可命中 Wechatpay-Serial）；
    // 路由：PUB_KEY_ID_* 前缀 → 两套公钥材料按精确 ID 匹配；否则按平台证书
    // serial_no 匹配缓存；两套均无匹配 → 验签失败，不跳过（§1.2）
    "migration_started_at": "<迁移开始时刻>",
    "migration_exit_condition": "连续 >=7 天（覆盖 15h 通知重发序列）所有入站通知 Serial 均命中 primary_mode 材料，且商户平台确认灰度结束；满足后将 verification_mode 固定为 primary_mode，并在新 config_revision 中清除 secondary_* 与 migration_* 字段（原子切换）",
    "migration_deadline": "<迁移截止时刻；超期未退出 → 告警并保持双模式，不自动收敛>",
    "notify_url": "https://<联调域名>/payment-callbacks/wechat",
    "product_evidence_refs": { "native": "evidence://<索引>", "h5": "evidence://<索引>" }
  },
  "alipay": {
    "app_id_ref": "kms://alipay/appid",
    "app_private_key_ref": "kms://alipay/app-private-key",
    "key_type": "PKCS1 | PKCS8",   // 必显式：官方密钥工具默认生成格式与 SDK 默认解析格式不一致
    "api_family": "legacy_gateway",
    "gateway": "https://openapi.alipay.com/gateway.do",
    "verification_mode": "public_key | certificate",
    // public_key（默认）模式必填，其余模式相关引用必须缺省：
    "alipay_public_key_ref": "kms://alipay/alipay-public-key",
    // certificate（分支）模式必填（三证角色见冻结表 §2.3.1），其余必须缺省：
    "app_cert_ref": "kms://alipay/app-cert",                     // → app_cert_sn，随请求上送
    "alipay_public_cert_ref": "kms://alipay/alipay-public-cert", // → 按 alipay_cert_sn 匹配后验签
    "alipay_root_cert_ref": "kms://alipay/alipay-root-cert",     // → alipay_root_cert_sn
    // 模式切换/换钥窗口（流程见 §2.3.2，材料选择见 §2.3.3）：旧验签材料只读副本，
    // 仅验签、不得用于请求签名；单模式稳定态必须为 null（不得使用无类型数组）
    "previous_verification_material": null,
    // 窗口态示例（非 null 时须为以下有类型对象之一，字段按 mode 匹配）：
    // "previous_verification_material": {
    //   "mode": "public_key | certificate",              // 旧材料的模式（有类型）
    //   "config_revision": "<该材料所属的上一配置版本>",
    //   // mode=public_key 必填（密钥模式通知无序列号，选择规则见 §2.3.3 第 2 条）：
    //   "alipay_public_key_ref": "kms://alipay/previous-alipay-public-key",
    //   "alipay_public_key_note": "<可选脱敏标识：开放平台配置版本/上传时间，非凭据>",
    //   // mode=certificate 必填（按通知 alipay_cert_sn 精确匹配）：
    //   "alipay_public_cert_ref": "kms://alipay/previous-alipay-public-cert",
    //   "valid_from": "<平台侧变更生效时刻>",
    //   "not_after": "<撤销时刻，>= 通知重发末次 15h；过期未清除则新 config_revision 不生效>"
    // },
    "notify_url": "https://<联调域名>/payment-callbacks/alipay",
    "return_url_allowlist": ["https://<联调域名>/..."],
    "product_evidence_refs": { "page": "evidence://<索引>", "wap": "evidence://<索引>" }
  },
  "ops": {
    "secret_version": "<版本>",
    "rotation_owner": "<角色>",
    "expiry_policy": "<有效期与到期告警策略>",
    "evidence_set_version": "<证据集版本>",
    "consumer_signoff": null
  }
}
```

加载器必须满足（验收口径，来自上游需求/设计）：

- 引用缺失、`environment_kind` 与部署身份不符、产品不在 `allowed_products`、
  密钥不匹配 → 拒绝启用该渠道，按渠道隔离失败，不回退生产配置、不跳过验签；
- **模式与材料必须一致**：`verification_mode` 与对应有类型引用一一匹配
  （微信 public_key → 双公钥引用齐全 / platform_certificate → 仅 api_v3_key_ref；
  支付宝 public_key → 仅 alipay_public_key_ref / certificate → 三证齐全，
  见 §2.3.1）；混用、缺项或多填 → 拒绝启用；
- **键唯一**：配置每个对象不允许重复键，解析必须以严格重复键检查拒绝并整体失败，
  不得静默覆盖（用例 V-R15）；
- **微信迁移态**：`verification_mode=migration_dual` 时 `primary_mode`/`secondary_mode`
  必填、二者不等，且 secondary 对应有类型引用齐全（public_key → 双引用；
  platform_certificate → 无静态 ref，共用刷新缓存）；单模式配置中出现
  `secondary_*` 或 `migration_*` 字段 → 拒绝启用；迁移窗口内两套材料均只用于验签，
  商户请求签名始终只用 `signing_private_key_ref`（与灰度无关）；
- **支付宝切换窗口**：`previous_verification_material` 必须为 null 或 §3 模板所列
  有类型对象（不得为无类型数组）；`mode` 与其对应引用一一匹配，缺项或多填 → 拒绝
  启用；加载时须校验 previous 材料与当前 `app_id` 同应用，校验不过 → 拒绝启用；
  窗口内旧材料**只允许验签**、不得用于请求签名；`not_after` 过期未清除 →
  新 `config_revision` 不生效；
- `sales_enabled` 必须显式为 `false` 才允许进入联调；
- 公开诊断只输出 `config_revision`、脱敏身份、加载成功布尔与固定错误码，
  不输出解析异常原文、材料正文或配置全文；
- 环境之间不复用密钥引用或交易标识空间；
- 本模板不是加载器，不以"JSON 校验通过"冒充 AC2/AC4/AC7 完成。

## 4. 环境与网络核查记录（本节点实测）

执行环境：本地开发机（macOS / Darwin 27.2.0），核查日期 2026-11-18。
**范围声明**：以下均为"本机经代理网络路径可达性"证据，不是目标联调部署的公网
回调域证据；AC3 必须由部署/域名负责人从部署网络之外重复执行并对照处理器记录。

| 检查 | 命令 | 期望 | 实际（2026-11-18） | 结论 |
| --- | --- | --- | --- | --- |
| E1 仓库基线 | `git rev-parse HEAD` | 与上游报告一致 | `0e7b6a6d7b82c2433ec839cd3ac1f3e322752c00`，分支 `feature/fix-issue-63-20261118-1956`，工作树干净 | 通过 |
| E2 服务端无渠道实现 | `rg -n -i 'payment-callbacks\|wechat\|alipay\|paymentAdapter' server/src server/tests app` | 无适配器/加载器实现 | 仅 `contracts/billing/{openapi.yaml,schemas/*}` 存在回调与渠道合同；`server/src`、`server/tests`、`server/package.json`、`bun.lock` 无微信/支付宝 SDK 或适配器 | 与设计一致：加载入口未交付，AC2/AC4/AC7 无运行入口 |
| E3 本地容器工具 | `docker --version`；`docker-compose --version` | 隔离联调可用 | Docker 29.8.2（build 7fc2dff）；docker-compose v5.5.0（standalone，`docker compose` 子命令插件未装）；Node v26.13.1；Bun 1.4.4 | 可用；注意本机用 `docker-compose` 命令 |
| E4 微信网关 HTTPS | `curl https://api.mch.weixin.qq.com/` | TLS 可达 | HTTP 404，TLS 验证通过（`ssl_verify_result=0`） | 网关可达 |
| E5 支付宝网关 HTTPS | `curl https://openapi.alipay.com/` | TLS 可达 | HTTP 302，TLS 验证通过 | 网关可达 |
| E6 支付宝沙箱网关 | `curl https://openapi-sandbox.dl.alipaydev.com/` | TLS 可达 | HTTP 302，解析到真实 IP `110.75.132.25` | 沙箱网关仍在线 |
| E7 网关证书主体 | `openssl s_client -connect ... \| openssl x509 -noout -subject -issuer -dates` | 官方主体、有效期内 | 微信：`CN=payapp.weixin.qq.com`（Tenpay），DigiCert 签发，2026-09-15 → 2027-04-01；支付宝：`CN=*.alipay.com`（Alipay），DigiCert 签发，2026-08-18 → 2027-03-04 | 证书真实有效 |

**网络路径限制**：本机 DNS（223.5.5.5）对 `api.mch.weixin.qq.com`、`openapi.alipay.com`
返回 `198.18.0.x`（fake-ip 保留段），说明流量经本地代理转发；E4–E7 只证明
"经本机代理路径 + 默认 CA 信任下 TLS 校验通过"，**不能**代表目标部署机的直连路径、
防火墙策略或渠道后台登记状态。E4–E7 未携带任何商户凭据、未调用任何交易接口，
仅属于环境预检，不构成 AC3 证据。

## 5. 能力矩阵（全部待验证）

所有格当前为 **阻塞待验证**：无真机/授权核查证据。本表固定每格的"验证路线 + 降级
要求"，供 AC5 执行时逐格填写；任何格不得在取得真机证据前对用户宣称支持。
微信内置浏览器一格 **不启用 JSAPI**：无论验证结果如何，生产允许列表必须排除 JSAPI，
未验证或不支持时只能做外部浏览器引导，不得循环唤起或伪报成功。

| 打开环境 | 微信路线（待验证） | 支付宝路线（待验证） | 降级要求 |
| --- | --- | --- | --- |
| 电脑浏览器扫码 | Native 下单 → 展示二维码；需 mchid/appid 绑定 + Native 产品已开通 | 电脑网站支付收银台扫码 | 提示受支持的外部浏览器/设备 |
| 外部手机浏览器 | APIv3 H5 下单（`h5_url` 重定向）；核查域名条件与回跳 | 手机网站支付（跳转唤起）；核查回跳条件 | 给出受支持浏览器与打开步骤 |
| 微信内置浏览器 | **不假定 H5 可用；本票不启用 JSAPI** | 独立核查跨应用唤起限制 | 明确引导到外部浏览器，不循环唤起、不伪报成功 |
| 桌面客户端打开网页 | 系统外部浏览器按电脑路线；内嵌 WebView 单独标记 | 同左 | 内嵌不支持时打开系统浏览器 |

AC5 执行时每格须补：OS、浏览器/客户端精确版本、真机或桌面环境、结果
（已验证支持 / 不支持并引导 / 仍阻塞）、证据索引。手机模拟 UA 不替代真机；
页面回跳不证明付款。

### 5.1 冻结表自检用例（#69 实现时的最低拒绝/接受覆盖；结果待实现后回填，当前全部未执行）

| ID | 用例 | 期望 |
| --- | --- | --- |
| V-R6 | 微信查单（微信单号）构造请求缺 `mchid` query 参数 | 客户端本地拒绝、不发出请求；带 `mchid` 时签名覆盖含 query string 的完整 URL 目标（§1.1） |
| V-R7 | 支付宝通知携带未知 `alipay_cert_sn`（证书模式）/ 微信通知携带未知 `Wechatpay-Serial` | 验签失败：不跳过、不确认到账、无账务变化（§1.2、§2.3.1） |
| V-R8 | 模式与材料不一致（public_key 混入证书三证、缺 `alipay_public_key_ref` 等） | 配置加载拒绝启用该渠道（§3 验收口径） |
| V-R9 | 切换窗口内旧材料被用于请求签名 / `previous_verification_material.not_after` 过期未清除 | 拒绝：旧材料仅可验签；过期未清除则新 `config_revision` 不生效（§2.3.2、§3） |
| V-R10 | 微信灰度迁移态：通知 A 带 `PUB_KEY_ID_*` Serial（命中 secondary 公钥）、通知 B 带平台证书 Serial（命中 primary 刷新缓存） | 两类合法签名均验签通过并正常业务处理（§1.2、§3） |
| V-R11 | 微信 `migration_dual` 下未知 Serial：既非两套公钥 ID、也非刷新缓存证书 serial_no | 验签失败：不跳过、不确认到账、无账务变化 |
| V-R12 | 支付宝切换窗口内合法旧签名通知（窗口未过 `not_after`，含携带与不携带 `alipay_cert_sn` 两种） | 按 §2.3.3 规则命中 previous 材料验签通过并正常业务处理 |
| V-R13 | 支付宝窗口过期后的旧签名通知；及无 `alipay_cert_sn` 且两套材料均验签失败 | 验签失败：不跳过、不确认到账（§2.3.3） |
| V-R14 | 平台已切换但本地激活失败：主动查单持续被网关签名校验拒绝 | 停止该渠道主动请求重试并告警；不自动切换新材料、不自动回退；按 §2.3.2 第 4 条人工处置 |
| V-R15 | 配置对象含重复键（如两个 `notify_url`） | 严格解析拒绝并整体失败，不静默覆盖（§3 键唯一） |
