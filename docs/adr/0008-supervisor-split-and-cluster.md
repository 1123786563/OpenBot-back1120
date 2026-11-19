---
status: proposed
---

# Supervisor 与后端分离部署，集群调度收在 Server，Supervisor 保持哑服务

Supervisor（创建、停止、重置、列出 Bot 工作计算机容器的服务）可与 API server 分机部署，让浏览器与命令执行占用另一台机器的 CPU 和内存；多台时以"server 持放置表、supervisor 逐台哑管理"的方式构成集群。Supervisor 自身不加协议、不加共识、不改代码（分机部署需三处小改动，见下）。

## 分离部署

前提是私有网络（WireGuard/Tailscale 或 VPC 内网）：server 直连 supervisor，也直连 supervisor 建出的每台 computer，supervisor 不代理后者。`SUPERVISOR_TOKEN` 是共享秘密而非网络边界，公网部署必须再套 TLS 反代并按来源限白名单；Docker socket 永不出 supervisor 所在主机。

需要三处改动，缺一不可，均默认保持现状行为：

1. supervisor 侧新增 `COMPUTER_PUBLISH_IP`：computer 的动态端口现硬编码绑 `127.0.0.1`（`supervisor/src/docker.ts`），分机时须绑到本机内网地址。
2. server 侧新增 `COMPUTER_URL_HOST`：`hostForPort` 现把动态端口拼成 `http://127.0.0.1:<port>`（`server/src/computer/supervisor.ts`），分机时须拼成对端地址。
3. `scripts/start.sh` 在 `OPENBOT_ONE_COMPUTER_EACH=true` 时无条件注入 `COMPUTER_SUPERVISOR_URL=http://localhost:4500`，须改为 `.env` 已设值则不覆盖。

computer 的每台 token 由 `COMPUTER_TOKEN` 无状态 HMAC 派生，跨机天然可用，两机共享同一 `COMPUTER_TOKEN` 即可。否决 `COMPUTER_NETWORK` 跨机方案：容器名仅在同一 Docker 网络内可解析，跨机还需自建 DNS 与路由，贵于上述改动。

失败模式：两机断链即全部 computer 同时不可达，server 每次调用 45 秒超时；登录态与文件在对端卷上，链路恢复即恢复，不丢数据。

## 集群

否决在 supervisor 前挂负载均衡：`ensure` 按主机幂等，轮询会把同一个人的 computer 建到随机节点并使 server 的记录失效。放置（谁的 computer 在哪台）必须只有一个真相来源。

集群设计：

- 配置从单一 `COMPUTER_SUPERVISOR_URL` 变为列表；各节点共享 `SUPERVISOR_TOKEN` 与 `COMPUTER_TOKEN`。扩容单位是 Docker 主机，一主机一 supervisor，瓶颈是每台 Chromium 的内存而非 supervisor。
- 新增 `computer_placement` 表（Postgres）：computer 到节点的归属。`ensure` 先查表路由到归属节点；新 computer 选节点（初期各节点 `list()` 称重或简单轮询）后落表。表在 Postgres，多个 server 副本自然兼容，与现有 `LISTEN/NOTIFY` 多副本设计一致。
- 亲和规则：一个人的 computer 永远留在首次放置的节点——浏览器 profile 与工作目录是节点本地的 named volume，不跟人走。
- 故障策略：节点失联（`/health` 探测）默认**等它回来**，卷与登录态俱在；跨节点重建即丢登录态与文件，且现有卷复制仅在同机内可用，跨机卷同步明确排除在本设计外。
- 同样否决：supervisor 间通信协议、共识、NFS 等网络存储共享卷（Chromium profile 与锁文件在网络存储上不可靠）。

## 未验证项

跨机连通未实测；`COMPUTER_NETWORK` 跨机不可行的判断仅来自代码阅读；截图与 snapshot 走 server↔computer 链路的带宽占用未测量。本 ADR 为设计决策，不代表已实现。

---

术语缺口：`GLOSSARY.md` 尚无 Supervisor 词条（Computer、Isolated Bot 已有），待领域建模补录。
