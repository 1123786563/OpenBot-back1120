# Casdoor 对接：实现前核查

依据：[ADR 0001](../adr/0001-casdoor-identity.md)。状态：后端能力核查已完成，端到端实现等待可修改服务端源码或经过验证的扩展接口。

## 实际核查结果

- 当前 checkout 没有 `server/` 源码；通过 GitHub contents API 检查公开上游 `CopilotKit/OpenBot` 根目录，也未发现该目录。
- `.github/workflows/images.yml` 说明服务端、计算机与 supervisor 复用发布镜像，而非在此仓库构建。
- 本地 `ghcr.io/copilotkit/openbot:main` 的镜像摘要为 `sha256:58c6637b6f8250fbb2cea20b37c382ba7a9cebab145b6b164481c78031202084`。使用无网络临时容器检查：`/app/bin/openbot` 为编译程序，`/app/server` 仅有 `drizzle` 迁移目录。镜像标注源码地址为 `https://github.com/CopilotKit/OpenBot`。未找到可挂载认证代码的受支持扩展点；这不证明私有扩展接口不存在。
- 本地已存在 `docker-compose.casdoor.yml` 和运行中的 Casdoor；未修改其配置或账户。读取 `http://localhost:8000/.well-known/openid-configuration` 成功，issuer 为 `http://localhost:8000`，包含授权、令牌、UserInfo、JWKS 和退出端点，声明 `S256` PKCE 与 back-channel logout 支持。尚未验证授权码交换或真实用户登录。
- 邻接目录 `../casdoor` 存在，origin 为 `1123786563/casdoor`；它不是 OpenBot 服务端源码。

## 已有接口及缺口

| 能力 | 现有依据 | ADR 所需补充或验证 |
| --- | --- | --- |
| OIDC 注册 | `api/openapi/accounts.yaml` 要求管理员 Web 会话、组织 ID 和邮箱域名 | 无已有管理员的启动配置；公开邮箱统一登录入口；不能假设域名通配受支持 |
| 创建组织 | `api/openapi/organizations.yaml` 支持创建者成为 owner 和幂等键 | 首次登录原子创建唯一个人空间、设置活动组织、防止重复及跨用户访问 |
| 停用 | `docs/configuration.md` 的 SCIM 会结束会话、禁用邮箱、撤销连接凭据并停止计算机 | 不能直接将其用于身份服务故障暂停；需稳定身份关联、保留数据和凭据、全部后台执行停止及一分钟时限 |
| 身份服务不可用 | 未发现满足要求的现成配置 | 服务端访问和执行的状态有效期；不可访问时到期暂停；恢复不自动重启任务 |
| 多端 | Web/移动端已有认证客户端；桌面端默认个人免登录部署 | 云端桌面模式、三端回调、统一账户、当前端及全部设备退出 |

现有 `OPENBOT_ORGANIZATION_AUTH_URL` 指向另一个 OpenBot 身份权威服务，不能直接填 Casdoor 地址。仅在网关检查登录也无法证明后台任务和计算机已停止，因此不作为替代后端实施方案。

## 获得服务端入口后的实施顺序

1. 在独立测试数据库与固定镜像版本上验证 Casdoor OIDC；确认 issuer/subject 稳定关联、邮箱验证、管理员启动及回调配置。不得将客户端 secret 放入 Web 或移动端。
2. 实现首次登录创建个人用户和唯一组织，覆盖并发登录、初始化失败重试、邮箱变更和越权访问。
3. 实现账户状态检查、通知验签与重放防护、会话撤销、执行停止；验证通知丢失与身份服务故障时仍在一分钟内阻断，并且恢复不自动重启。
4. 对接三端统一入口和退出，桌面端切换到云端模式。
5. 用两个独立用户验证数据库/API、文件、浏览器登录态、连接凭据和计算机隔离，完成管理员运维恢复演练。

目前只完成只读能力核查与设计记录，未声称已完成 Casdoor 登录或 SaaS 隔离；未启动或修改现有 OpenBot 服务、数据库或用户账户。
