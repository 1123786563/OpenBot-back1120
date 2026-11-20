# 官方同步返回验签样例（逐字保留）

来源：https://opendocs.alipay.com/common/02mse7.md（文档更新时间
2026-03-26 16:54:27；抓取于 2026-11-19）“同步返回验签 · 公钥模式”一节。
以下内容为官方文档原文复制，未做任何改写。

## 1. 官方给出的响应值（当面付扫码支付 alipay.trade.precreate）

```json
{"alipay_trade_precreate_response":{
  "code":"10000",
  "msg":"Success",
  "out_trade_no":"6141161365682511",
  "qr_code":"https:\/\/qr.alipay.com\/bax03206ug0kulveltqc80a8"
},
 "sign":"VrgnnGgRMNApB1QlNJimiOt5ocGn4a4pbXjdoqjHtnYMWPYGX9AS0ELt8YikVAl6LPfsD7hjSyGWGjwaAYJjzH1MH7B2/T3He0kLezuWHsikao2ktCjTrX0tmUfoMUBCxKGGuDHtmasQi4yAoDk+ux7og1J5tL49yWiiwgaJoBE="
}
```

官方 `sign` 值由支付宝平台私钥生成；平台私钥不可获得，故本仓库的向量
测试保留同样的响应节点原始排版（含 `\/` 转义与换行）、用运行时生成的
测试密钥按 SHA256WithRSA 对原始字节重签。

## 2. 官方给出的待验签字段

```json
{
  "code":"10000",
  "msg":"Success",
  "out_trade_no":"6141161365682511",
  "qr_code":"https:\/\/qr.alipay.com\/bax03206ug0kulveltqc80a8"
}
```

官方规则要点：`xxx_response` 的 JSON 值内容需要包含首尾的 `{` 和 `}`
（双引号也参与验签）；`http://` 中的正斜杠按响应原样（`\/` 转义形态）
参与验签；用支付宝公钥做 SHA256WithRSA 验签。

## 预期结果

- 按上述原始排版重签后，生产验签代码
  （server/src/payments/alipay/signature.ts 的 `verifyAlipayResponse`）
  必须返回 true。
- 同一响应若被 JSON 重新序列化（键序、空白或 `\/` 形态改变）后再验签，
  必须失败——即生产代码绝不能重新序列化后验签。
