# 官方异步通知样例（逐字保留）

来源：https://opendocs.alipay.com/common/02mse7.md（文档更新时间
2026-03-26 16:54:27；抓取于 2026-11-19）。以下内容为官方文档原文复制，
未做任何改写。

## 1. 官方给出的完整通知 URL（示例）

```text
https://api.xx.com/receive_notify.htm?total_amount=2.00&buyer_id=2088102116773037&body=大乐透2.1&trade_no=2016071921001003030200089909&refund_fee=0.00&notify_time=2016-07-19 14:10:49&subject=大乐透2.1&sign_type=RSA2&charset=utf-8&notify_type=trade_status_sync&out_trade_no=0719141034-6418&gmt_close=2016-07-19 14:10:46&gmt_payment=2016-07-19 14:10:47&trade_status=TRADE_SUCCESS&version=1.0&sign=kPbQIjX+xQc8F0/A6/AocELIjhhZnGbcBN6G4MM/HmfWL4ZiHM6fWl5NQhzXJusaklZ1LFuMo+lHQUELAYeugH8LYFvxnNajOvZhuxNFbN2LhF0l/KL8ANtj8oyPM4NN7Qft2kWJTDJUpQOzCzNnV9hDxh5AaT9FPqRS6ZKxnzM=&gmt_create=2016-07-19 14:10:44&app_id=2015102700040153&seller_id=2088102119685838&notify_id=4a91b7a78a503640467525113fb7d8bg8e
```

官方 `sign` 值由支付宝平台私钥生成；平台私钥不可获得，故本仓库的向量
测试保留同样的字段与同样的待验签串、用运行时生成的测试密钥重签。

## 2. 官方给出的待验签串（除去 sign、sign_type，url_decode 后字典序）

```text
body=大乐透2.1&buyer_id=2088102116773037&charset=utf-8&gmt_close=2016-07-19 14:10:46&gmt_payment=2016-07-19 14:10:47&notify_time=2016-07-19 14:10:49&notify_type=trade_status_sync&out_trade_no=0719141034-6418&refund_fee=0.00&subject=大乐透2.1&total_amount=2.00&trade_no=2016071921001003030200089909&trade_status=TRADE_SUCCESS&version=1.0
```

## 3. 官方验签步骤（原文要点）

1. 除去 `sign`、`sign_type` 两个参数外，凡是通知返回的参数皆是待验签的
   参数（生活号异步通知需保留 sign_type，本票场景不涉及）。
2. 剩余参数 url_decode 后字典序排序，组成 `k=v&k=v` 待签名字符串。
3. `sign` base64 解码为字节串。
4. 用支付宝公钥做 RSA 验签（RSA2 = SHA256WithRSA）。

## 4. 已知的官方文档示例不一致（记录）

官方第 2 步给出的待验签串**遗漏了**第 1 步样例中同样存在的
`app_id`、`gmt_create`、`notify_id`、`seller_id` 四个参数——这是文档示
例自身的瑕疵。规则的权威表述（“除去 sign、sign_type 外皆是待验签参数”）
与官方 SDK 的 `AlipaySignature.verifyV1` 一致：四个参数都参与验签。向量
测试据此按规则全集生成待签串，并断言：只取官方串所含字段、按同规则排
列时，输出与官方串逐字节一致。

## 预期结果

- 上面的字段集合与待验签串经官方规则重签后，生产验签代码
  （server/src/payments/alipay/signature.ts 的 `verifyAlipayNotification`）
  必须返回 true。
- 任一参数被篡改（例如 total_amount 2.00 → 0.01）后验签必须返回 false。
