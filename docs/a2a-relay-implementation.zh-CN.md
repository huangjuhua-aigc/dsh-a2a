# A2A 中继实现与验证记录

日期：2026-10-30。状态：本地实现和自动化验证完成，源码按下方仓库发布；尚未部署到公网。Portal 与调用技能版本为 0.2.0，Relay、Connector 和中继协议版本为 0.1.0；DSH 插件运行代码未变，继续使用 npm 0.3.0。

## 代码位置

| 仓库 | 实现 |
| --- | --- |
| [a2a-relay-server](https://github.com/huangjuhua-aigc/a2a-relay-server) | 独立 Git 仓库，HTTP/WS Relay、SQLite 注册与发布状态、限流、撤销、本地管理员命令、代理配置、中英文 README |
| [Talk2MyAgent](https://github.com/huangjuhua-aigc/Talk2MyAgent) | `packages/a2a-connector` 后台进程与独立 CLI；`packages/a2a-relay-protocol` 传输协议；现有 Portal/CLI 的发布管理；访客邀请与调用技能的完整名片地址支持 |
| [dsh-a2a](https://github.com/huangjuhua-aigc/dsh-a2a) | 实际 DSH harness 的中继集成测试和文档；插件运行代码、访客读取权限及自动简报行为没有改动 |

Relay 随仓库包含共享协议的代码快照，因此可以独立安装运行，不要求开发者的目录结构与本机相同。协议主源位于 Talk2MyAgent；同步脚本和两端互操作测试防止版本偏离。

## 完成的用户流程

用户在 Portal 选择默认 Relay 或自定义 host，开启后由后台自动注册并启动 Connector；在线后显示地址，可以选择访客并复制完整聊天邀请。新建向导选择中继时，在保存、启动 agent 后自动发布。

关闭 Portal 不停止已启动 Connector。关闭发布会停止转发，保留本地 agent；断网自动重连并沿用原地址。跨 host 的设备凭据分别保存，不发送旧 host 凭据给新服务。离线或凭据尚未应用时不生成邀请，也不使用 localhost 占位。

Portal 已统一表单与状态布局，Relay host 使用全宽输入，网络设置按选择展开。主页四个区块支持折叠，按 Agent 记住状态，折叠时保留未保存输入。启动前检查本地 Agent 端口占用并提示处理位置；本地 Agent 默认 3080、Relay 默认 8787，两者独立。

调用技能增加中英文说明、完整中继名片路径支持，并修复 `GetTask` 直接返回 Task 时的解析。令牌保留在环境变量，通讯录只记录变量名。升级技能不改变联系人或凭据。

注册接口只保存设备凭据 SHA-256 摘要。访客令牌由本地 A2A 校验；Relay 只开放公开名片和固定 RPC 路由。私有 Connector 目录不能与任何已配置访客目录重叠。Portal 增加 Host/Origin 检查、浏览器会话防伪令牌，发布写操作串行处理。

传输支持 A2A 1.0 JSONRPC 和 SSE，公开及扩展名片地址会改写。UTF-8 按字节传输，响应有累计 credit 和有限窗口；请求、帧、并发、队列与超时均有上限。断线不重发：已经被 agent 接受的任务不能因为响应丢失而被重复创建。

## 与设计草案相比的首版实现选择

- Connector 和协议库使用可直接运行的 Node ESM；现有 Portal 仍使用 TypeScript/React。运行环境要求 Node 22.13+。
- 关闭发布后保留轻量的本机 IPC 控制进程，转发连接全部关闭。独立 CLI 的 `shutdown` 会退出进程。尚未安装开机服务，机器重启后由 Portal/CLI 恢复。
- 默认公网 host 通过 `A2A_RELAY_DEFAULT_HOST` 注入，当前没有虚构或硬编码一个官方线上地址。用户可在页面自行配置 host。
- 重试连接阶段显示“正在重连／等待本地 agent”。后台只在本地名片验证和 Relay ready 握手完成后显示在线。
- 旧版本正在运行的 agent 需通过新 Portal 重启一次以记录实际监听和已应用权限。权限、令牌变更后同样要求重启；仅保存配置不能生成一份声称已生效的邀请。
- Relay 数据库支持凭据到期字段，默认长期有效直到撤销；目前没有账号、配对页面或凭据轮换 UI。本机管理员撤销后新请求立即拒绝，已有隧道最多在 20 秒内关闭。
- 当前验证支持无签名、单接口 A2A 1.0 JSONRPC 名片，不提供闭源 agent 入站适配、MCP 桥接、通用 TCP 转发或多实例集群。

## 自动化验证结果

环境：Windows、Node 24.19.0、pnpm 11.22.0、Playwright 1.58.2 / 无头 Microsoft Edge。全部使用隔离临时目录和测试端口，没有启动或重启用户现有 agent。

| 测试组 | 结果 |
| --- | --- |
| dsh-a2a 原有回归 + 新增真实 DSH 中继测试 | 218 / 218 通过 |
| 独立 Relay HTTP / SQLite / 注册与限流 | 3 / 3 通过 |
| Connector 协议与目录边界 | 2 / 2 通过 |
| Relay + Connector 跨仓库集成 | 4 / 4 通过 |
| Portal 后端 / CLI 回归 | 13 / 13 通过 |
| A2A 调用技能 CLI | 5 / 5 通过 |
| Portal UI 自动化 | 31 / 31 通过 |
| 合计 | **276 项通过，本次运行无跳过** |

dsh-a2a 和 Portal 的 TypeScript 检查、Portal 生产构建均通过。

中继用例涵盖：注册幂等与持久化、过期发布意图拒绝、撤销、Host 欺骗、访客鉴权、管理路由不暴露、名片改写、中文/emoji 分块 SSE、超大请求拒绝、并发限额、访客断开后的资源释放、隧道重连不重发、后台进程单实例和身份恢复、切换 Relay 时凭据隔离。

新增 UI 用例串起真实 Portal、Relay、后台 Connector、调用技能 CLI：默认发布、复制邀请、真实 HTTP 聊天、刷新页面、关闭/重开且地址不变；另外覆盖自定义 host 填错后修正重试、剪贴板失败后的手动复制、未应用凭据拒绝邀请、本地 agent 不可达时禁用邀请及关闭发布。另有 9 项布局与折叠用例，验证桌面/平板/手机、键盘焦点、访客指令展开、首次使用、状态记忆和输入保留。其余 19 项保留公开简报、访客记录、向导和管理操作回归。

DSH 集成使用真实协议、真实 harness 和确定性模型适配器，验证鉴权、扩展名片、完整任务回复与 SSE。没有付费模型调用；原有 upstream 字符解码保护未移除，也没有据此宣称上游缺陷已解决。

自动化之外，另按用户请求完成本机真实服务的重启、Relay 名片读取、访客消息提交和同一任务查询，取得已完成回复。这是本机回环地址的验收，不代表跨公网可达性验证。

## 重跑

三个仓库分别先安装依赖。在 Talk2MyAgent 中执行：

```powershell
$env:A2A_RELAY_SOURCE='D:\code\a2a-relay-server'
pnpm --filter @talk2myagent/a2a-connector test
pnpm --filter @talk2myagent/a2a-connector test:integration
pnpm --filter @talk2myagent/a2a-host test:all
pnpm --filter @talk2myagent/a2a-skill test
```

在 dsh-a2a 中执行：

```powershell
$env:A2A_RELAY_SOURCE='D:\code\a2a-relay-server'
$env:A2A_CONNECTOR_SOURCE='D:\code\Talk2MyAgent\packages\a2a-connector'
pnpm test
pnpm typecheck
```

在 a2a-relay-server 中执行 `pnpm test`。环境变量换成各自检出路径即可。不设置跨仓库路径时，普通回归可以独立运行；DSH / UI 中的 Relay 集成用例会明确标记跳过。

## 线上验收边界

本轮验证的是本机真实 HTTP/WS 链路。生产域名、HTTPS/WSS 反向代理、Linux 后台进程生命周期、跨网连接和生产负载仍需在选定部署环境验收。Relay 在 TLS 终止处能看到转发内容和访客令牌，当前没有端到端加密。

部署说明分别位于 Relay 的中英文 README 和 Talk2MyAgent 的 `docs/relay.md`、`docs/relay.en.md`。下一步上线时提供实际默认 Relay host，完成环境验收后再开放服务；源码推送不等于公网部署或新 npm 版本发布。
