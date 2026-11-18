# T01 真实联调复现（不以脚本局部成功代替整票验收）

从 `OpenBot/` 执行。必须具备本机 Docker、Compose、npm（解析固定 Bun）、源码读写权限。
**不运行根目录 scripts/start.sh，不使用用户的旧数据库或 8091。**

## 全新专用环境

```sh
npm exec --yes --package bun@1.4.3 -- bun deploy/t01/setup.ts
bash deploy/t01/deps.sh
npm exec --yes --package bun@1.4.3 -- bun --env-file=deploy/t01/.env.t01 deploy/t01/provision-casdoor.ts
```

setup 不覆盖现存私有配置；数据库为空时 Casdoor 自行迁移，OpenBot 由 up 的 migrator 迁移。
Casdoor 是固定 digest 的 `casbin/casdoor`，不是不存在的 `casdoor/casdoor`。
需要管理 UI 时，在 http://localhost:18000/init-admin 设置仅本次使用的管理员密码；不得贴进报告。
provision 只读取本项目独立 `casdoor-db` 中内建应用的引导凭据，随后通过真实 Casdoor 公开 API 创建 `openbot-t01` 组织、`app-t01` 应用和 A/B/denied 用户；重跑不重建用户或更换密码。
`a@t01.test` 为 OpenBot 初始管理员；`b@t01.test` 为普通用户；`x@other.test` 为拒绝域用例。
密码仅在 `.runtime/casdoor-users`（600，父目录700）；OIDC client secret 仅在 `.env.t01`。

运维提供的三个真实 Intelligence 项通过仓库外 `T01_INTELLIGENCE_ENV` 补充文件加载，默认 `$HOME/.agentflow-runner-t01/intelligence.env`（0600）。不得复制为 VITE 变量。补充文件仅允许上述三项与 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`BOT_MODEL`、`COPILOTKIT_OPENAI_API` 七个字段，其他认证/部署字段一律拒绝；文件本身要求组和其他用户不可读。不能把 Intelligence key 当模型 key。
模型协议记录：`BOT_MODEL=GLM-5.3-Flash`（chat/completions）曾真实 403 `model_access_denied`——模型列表 200 不证明生成权限；运维核实供应端规范 slug 为 `glm-5.3-flash` 且该网关仅对 `/responses` 授权后，补充文件改为规范 slug 并加 `COPILOTKIT_OPENAI_API=responses`（CopilotKit 自身协议开关，非密钥），真实 `/responses` 生成 200。服务端环境过滤（`serverEnvironment`）以 `.env.t01.example` 名单转发该字段，example 中已列出。

```sh
# 可通过 T01_BUN 指定已经安装的固定 Bun 二进制；否则脚本用 npm 的 bun@1.4.3。
bash deploy/t01/execution.sh   # 从真实同分支源码构建专用 computer/supervisor，非旧实例镜像
bash deploy/t01/up.sh         # 安装、迁移、构建、启动真实 server+worker
```

源码宿主进程监听 13001，静态 app 同端口；Casdoor issuer http://localhost:18000 对浏览器与服务端相同。无匿名管理员模式。
本机运行 OpenBot 自身仍监听宿主接口；必须在可信本地测试主机使用，不能将本地 HTTP 配置发布到生产。

## 真实浏览器登录

1. 使用平台原生 browser 工具访问 http://localhost:13001/sign → Continue with Okta（现有按钮标签）。授权请求必须指向 **18000 的 Casdoor**，client_id=t01-openbot、PKCE S256、有 state/nonce；实际 redirect_uri 必须是 `http://localhost:13001/api/auth/callback/okta`。
2. 用专用 A 身份登录，返回 onboarding；从同一浏览器请求 `/api/me`，必须200且email=a@t01.test。匿名同请求必须401。`GET /api/me/profile` 本版本不是身份读取API。
3. 在另一隔离 browser context 登录 B，必须200且role=user。保留原 A/B cookie **仅在** `.runtime` 下，不打印Cookie或授权码。
4. 平台 Playwright 代码可 `await context.storageState({path:'OpenBot/deploy/t01/.runtime/browser-a-current.json'})`（路径相对运行工作区）；B保存为 browser-b.json。chmod600。不要在填写密码后导出完整无脱敏DOM快照/HAR。
5. `bash deploy/t01/verify.sh login` 是真实已登录 cookie 的 API 探针，不会制造会话，也不替代浏览器授权码步骤。

## 初始化、拒绝与撤销

- 重复A登录 userId不变；`t01.login_initialized`仅首次用户创建一条（继承现有角色/onboarding默认值）；新的`session.signed_in`允许每会话一条。
- 真正以 denied 用户走Casdoor登录：OpenBot拒绝、匿名`/api/me`401、`users`无x@other.test，`session.refused`存在。
- 新匿名context测试缺state、错state与已消费的真实回调重放：不得有会话。回调302后仍需检查`/api/me`401，不能把302当成功。
- 普通B请求管理员revoke-sessions和fleet stop应403且不改变A目标。
- 用A管理员请求 `POST /api/admin/enterprise/people/<A-user-id>/revoke-sessions`。动作前保留**原始** A storageState为`.runtime/browser-a.json`；动作后该旧cookie的下一次`/api/me`401；B仍200。`bash deploy/t01/verify.sh revoked`作可重复断言。
- 已登录B带Origin=http://untrusted.invalid请求 `/api/auth/sign-in/social`应403 INVALID_ORIGIN；跨站 `/api/me` 不提供 CORS allow-origin。无Cookie的发起登录请求可以返回授权URL，但不能因此建立会话（Better Auth的实际策略）。
- 用户取消登录（历史轮次曾实测，本部署须复测）：匿名context点 Continue with Okta 到达 Casdoor 登录页后离开页面，OpenBot `/api/me` 必须401且停在 /sign。
- 错误回调（历史轮次曾实测，本部署须复测）：手工构造 authorize URL，`redirect_uri=http://localhost:13001/api/auth/callback/evil`；Casdoor 在登录页前直接拒绝（"doesn't exist in the allowed Redirect URI list"），无 code、浏览器不落在回调，`/api/me` 401。
- 错误 issuer（本轮已实测）：Bun 中 `--env-file` 的值**优先于**显式 shell 环境变量，因此 `OKTA_OAUTH_ISSUER=…18001 bun … launch.ts up` 这类 shell 覆盖不生效（服务仍用 `.env.t01` 里的 18000）。复现步骤：复制 `deploy/t01/.env.t01` 为临时副本，把副本中的 `OKTA_OAUTH_ISSUER` 改为 `http://localhost:18001`，用 `--env-file=deploy/t01/.env.t01.wrong-issuer` 重启 server；此时 `POST /api/auth/sign-in/social` 返回 400 `INVALID_OAUTH_CONFIGURATION`、不产出授权 URL、`/api/me` 401。复测后删除临时副本、恢复用原 `.env.t01` 重启，并确认 `/health` 200 且授权 URL 指向 18000（含 state 与 PKCE challenge）。
- 平台浏览器执行 `browser_run_code_unsafe`，filename=`OpenBot/deploy/t01/verify/oidc-failures.js`（从工作区根解析）：真实 state+无效 code 得到 invalid_code，客户端畸形/无签名 idToken 得到401 INVALID_TOKEN，各自 /api/me401。sign-in/social 存在客户端 idToken 注入面；单独合法签名 token 的 expiry/audience 子分支未逐项端到端注入，见根 implementation.md 的实际库契约与边界，不以其他拒绝替代。

## 后台执行与计算机

真实routine通过 `/api/channels` 建立本次channel、`POST /api/routines`创建、`POST /api/routines/:id/run`启动。**有可用模型凭据**且真实执行已开始后，才能测 `POST /api/routines/:id/runs/:runId/cancel`（owner作用域），返回202只表示发出中止，不是“已结束”。查询run终态并观察真实副作用≤30s结束、随后60s不再产生且无worker重派；无本地执行归属返回503，不伪写cancelled。此实现仅支持一个API进程，横向部署需持久取消信号。
本轮实测（探针 `deploy/t01/verify/cancel-sideeffect.ts`，证据 `.runtime/sideeffect-cancel-result.json`）：真实模型 turn 使 B 容器内副作用文件增长（3 行、循环进程活跃）后 owner cancel，202→3.4s 内文件停止增长、容器内循环进程消失，run 终态 `cancelled`（error="cancelled by an authorized request"），60s+/33 采样无再增长、无 worker 重派（`totalRuns=1`）、routine 保持禁用。凭据缺失或403阶段的失败run（`failed`）不得记为取消成功。

计算机可不经模型，用A/B各自真实会话请求 `POST /api/computers/general-assistant/exec`：
`{"command":"while true; do date +%s >> t01-computer-proof; sleep 1; done","timeoutMs":180000}`。
保留请求在进行中，确认两台本次namespace计算机及各自文件计数增长。
A管理员请求 `POST /api/computers/fleet`，body=`{"action":"stop","computer":"person:<A-user-id>"}`。
≤30s A容器停止/init PID=0，B仍运行；只查看状态，勿发送会唤醒A的新动作。

```sh
python3 -I deploy/t01/verify/computer.py --a openbot-t01-computer-person-<A-id> --b openbot-t01-computer-person-<B-id>
```

进程身份（ps 被拒的主机上 `launch.ts` 的实际回退路径）可用可执行探针复验：`"$T01_BUN" deploy/t01/verify/process-identity.ts`。它会以与 server 相同的可执行文件和相同工作目录启动一个无关 Bun 进程（同 executable/cwd、独立 stdout 文件），断言停止逻辑不会接受该 PID，并只 SIGKILL 自己启动的探针进程；任何一方不可观测时停止逻辑一律拒绝发信号。

该脚本观察31次、至少60秒的真实Docker状态；还需保留动作前实际进程/计数证据及旧连接终止证据。不把仅run行或仅停止viewer算成功。

## 重启、测试与清理

```sh
bash deploy/t01/stop.sh
bash deploy/t01/deps.sh
bash deploy/t01/execution.sh
bash deploy/t01/up.sh
bash deploy/t01/verify.sh revoked
# 再做一次真实浏览器登录与失败登录；原A旧cookie必须仍拒绝。
# 如需真正删除本次全部测试资源（包括动态计算机卷），只有显式破坏确认才执行：
bash deploy/t01/down.sh --destroy-t01
```

down只选择Compose项目openbot-t01及同时具有openbot.namespace=openbot-t01和openbot.supervisor的资源。不要docker system prune。无参数down必须拒绝。
回归使用单独的openbot_t01_unit：先在专用postgres创建此库，再把同一迁移应用于它，TEST_DATABASE_URL必须明确指定。不要在应用库或旧开发库跑有清理行为的集成测试。
日志、cookie、密码、密钥与原始认证证据都在gitignore的.runtime/.env.t01；只允许脱敏结果进入implementation.md。脚本失败均非零，跳过不算通过。


## 恢复补验：实际副作用、旧连接与重启

以下使用已有真实浏览器 storageState，不创建假会话。先完成上文A/B登录并确认当前A是管理员。固定Bun1.4.3执行；所有代码与结果路径从OpenBot目录解析。

```sh
npm exec --yes --package bun@1.4.3 -- bun deploy/t01/verify/cancel-sideeffect.ts
```

该脚本复用已有routine的channel或公开API创建channel，由真实模型启动240秒shell循环；在Bot工作目录观察增长、真实BASHPID，再通过owner cancel API取消并独立观察至少60秒。必须有真实模型及活动B computer；失败非零退出。结果写入私有`.runtime/sideeffect-cancel-result.json`，不以DB cancelled单独判断。脚本创建年度routine，取消后保持禁用。首次探针如果失败，核查run与实际执行，不能将failed终态记为取消成功。

另一个终端运行，保持其进程贯穿重启：

```sh
npm exec --yes --package bun@1.4.3 -- bun deploy/t01/verify/control-replay.ts
```

脚本先用当前B的真实storageState请求/api/me，默认断言b@t01.test，并核对容器namespace、supervisor、person-id及运行状态；A/B必须不同，验证失败在停止或撤销前退出。额外隔离观察身份可同时设置T01_B_STATE和T01_B_EMAIL（探针与重启解析使用相同环境），无需修改源码。然后使用A当前session：请求manual control→take→真实terminal socket写标记→fleet stop→原句柄重放→撤销A当前会话→旧凭据握手401→60秒Docker观察。它会打印ready并创建`.runtime/control-replay-ready`；只有看到本次ready才重启。A原storageState另存0600的control-replay-old-state.json；脚本不修改其他用户的会话。

保留探针运行，在另一终端执行（仅本项目，禁止启动已停止A）：

```sh
# T01_BUN可取.runtime/processes.json中executable，必须为1.4.3。
# 必须在停止服务前从当前真实B会话解析，校验身份及namespace；失败则不继续。
T01_B_CONTAINER=$("$T01_BUN" deploy/t01/verify/control-target.ts) || exit 1
"$T01_BUN" deploy/t01/launch.ts stop
docker compose -p openbot-t01 --env-file deploy/t01/.env.t01 -f deploy/t01/docker-compose.t01.yml restart postgres casdoor-db casdoor supervisor
docker restart "$T01_B_CONTAINER"
"$T01_BUN" --env-file=deploy/t01/.env.t01 --env-file="$HOME/.agentflow-runner-t01/intelligence.env" deploy/t01/launch.ts up
printf '%s' 'dedicated services restarted' > deploy/t01/.runtime/control-replay-restarted
```

launch/up确认健康后才创建restarted标记。探针会保持原句柄重放、原凭据重连401、再观察至少60秒，并从停止容器docker cp读取同一标记文件验证没有追加；结果control-replay-result.json。有效新授权主动请求可按既有ensure语义启动计算机；此脚本验证原连接不能续用，以及被撤销旧凭据不能重连，不把fleet stop解释为永久禁用用户。

```sh
npm exec --yes --package bun@1.4.3 -- bun deploy/t01/verify/cancel-after-restart.ts
bash deploy/t01/verify.sh revoked
```

cancel-after-restart读取同一副作用文件和PID，观察至少60秒且routine仍禁用、只有原cancelled run。之后再用新context执行真实A/B Casdoor登录和denied域拒绝；保留旧撤销凭据另行验证，勿覆盖成新登录凭据再称“旧凭据”。最后再次执行oidc-failures.js。原始日志不进入客户端或公开报告。
