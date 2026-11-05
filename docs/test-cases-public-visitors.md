# 公开访客：自动化与真实端到端测试

测试分为可重复的协议/UI 回归和真实模型验收。协议测试使用确定性模型；真实验收运行实际 DSH、DeepSeek、Microsandbox 和本地 Relay，所有数据均为新建的合成资料。它不使用生产 Relay，也不修改日常 Agent。

## 用例

| ID | 操作 | 预期结果 | 自动化位置 |
| --- | --- | --- | --- |
| P01 | 开关默认关闭；无凭据直接发送 | 拒绝，不创建身份、不调用模型 | dsh-a2a `tests/public-visitors.spec.ts` |
| P02 | 开启后无凭据发送普通/流式消息 | 401 明确指引登记，保留请求 ID，`requestAccepted=false` | 同上 |
| P03 | 登记时自填 visitorId 或超大参数 | 拒绝；正常登记由服务器生成随机 ID | 同上 |
| P04 | 使用 B 的 Token，在 metadata 伪造 A/owner 身份及额度 | 任务仍归 B，扣 B 额度，A 看不到任务 | 同上；本次新增 |
| P05 | 不同 context、流式和并发发送 | 累计最多 5 次，第 6 次不调用模型；状态查询不扣额度 | 同上 |
| P06 | 重启后查询身份/额度，关闭再开启 | 身份和已用额度保留；受邀访客不受公开额度限制 | 同上 |
| C01 | 无 Token 导入公开邀请并直接 send | 收到明确挑战后登记一次，保存凭据，继续同一个 messageId | Talk2MyAgent `packages/a2a-skill/tests/public-visitors.test.mjs` |
| C02 | 泛化 401、错误 request ID/domain、429/503、断线 | 不自动登记或重发；凭据保存失败也不继续消息 | 同上 |
| C03 | 第 6 次发送、重复 join、删除本机凭据 | 提示联系主人/恢复凭据，不自动领取新身份 | 同上 |
| C04 | 首次聊天前读取名片 | 不登记、不发送空 Bearer、不保存身份 | 同上；本次新增 |
| C05 | 缺少原凭据却使用 `--context` | 网络调用前拒绝，不用新身份续接旧对话 | 同上；本次新增 |
| C06 | 原受邀联系人再次导入不含 Token 的公开邀请 | 保留原 token_env；缺少环境变量时不降级匿名 | 同上；本次新增 |
| U01 | 切换公开开关、刷新、复制邀请、保存失败 | 持久化；邀请不含 Token，直接 send；失败保留旧状态 | Talk2MyAgent `packages/a2a-host/tests/ui/public-visitors.spec.ts` |
| U02 | Alpha 开启后切换 Beta，再返回 | 每个 Agent 的开关独立，不串状态 | 同上；本次新增 |
| U03 | 运行中的插件需要升级重启 | 显示说明，禁止复制尚未生效的公开邀请；受邀邀请仍可用 | 同上；本次新增 |
| H01 | 停止真实驻留子进程后立即绑定原端口 | 停止返回前进程已退出、端口已释放、PID 文件已清除 | Talk2MyAgent `packages/a2a-host/tests/dsh-stop.test.ts`；本次新增 |
| E01 | 实际 Portal 获取地址，再启动 Agent | 未启动也能分配固定编号；启动后 Connector 上线 | `scripts/record-public-e2e.mjs`（a2a-host） |
| E02 | Alice/Bob 经实际 CLI/Relay 聊天与 read_file | 服务端分配不同 ID；读出随机公共码和各自私有码 | 同上 |
| E03 | Python 对公共文件改写/删除/重命名/创建；对私有文件增改删 | 公共操作全部拒绝，私有 CRUD 成功，宿主原文件不变 | 同上；由测试者直接执行 VM 探针，未向访客开放执行工具 |
| E04 | Bob 读 Alice 路径、查询 Alice 任务 | 路径越界和任务查询均拒绝，不泄漏校验码 | 同上 |
| E05 | Alice 第 6 次、关闭公开开关、受邀访客发送 | 429 额度用完；新/已有公开访客被拒；受邀访客正常 | 同上 |
| E06 | 重新打开开关并重启 Agent | 地址不变，Alice 仍 0/5，Bob 身份和虚拟磁盘文件保留 | 同上 |
| E07 | 390 px 手机视口 | 无横向溢出 | 同上 |

## 回归命令

```powershell
# dsh-a2a
pnpm exec vitest run tests/public-visitors.spec.ts
$env:A2A_RELAY_SOURCE='D:\code\a2a-relay-server'
$env:A2A_CONNECTOR_SOURCE='D:\code\Talk2MyAgent\packages\a2a-connector'
pnpm exec vitest run tests/relay.integration.spec.ts
$env:A2A_MSB_TEST_RUNTIME="$env:USERPROFILE\.a2a\sandbox-runtime"
pnpm test:microsandbox

# Talk2MyAgent/packages/a2a-skill
pnpm test

# Talk2MyAgent/packages/a2a-host
pnpm build:web
pnpm exec playwright test tests/ui/public-visitors.spec.ts
pnpm typecheck
```

Microsandbox 常规套件使用可控时钟驱动真实 VM 的暂停、停止和恢复；完整 10 分钟实时时钟测试需额外设置 `A2A_MSB_WALLCLOCK=1`，否则该项明确跳过。

## 真实端到端与录屏复跑（Windows）

需要本机可用 DeepSeek 凭据、DSH、已准备的 Microsandbox 0.7.11、gstack browse 和 ffmpeg。每次使用新的报告目录。模型调用有实际费用。脚本在临时目录创建独立公共资料、Portal 配置、DSH profile、访客凭据和本地 Relay，不操作生产配置。

先构建 dsh-a2a 的 `pnpm build` 和 a2a-host 的 `pnpm build:web`。在 a2a-host 目录的第一个 PowerShell 终端启动：

```powershell
$env:A2A_REAL_E2E='1'
$env:A2A_PLUGIN_SOURCE='D:\code\dsh-a2a'
$env:A2A_RELAY_SOURCE='D:\code\a2a-relay-server'
$env:A2A_CONNECTOR_SOURCE='D:\code\Talk2MyAgent\packages\a2a-connector'
$env:A2A_SANDBOX_HOME="$env:USERPROFILE\.a2a\sandbox-runtime"
$env:A2A_REAL_AGENT_PORT='42001' # 可选：避免 Windows 动态保留端口；必须未被占用
$env:A2A_REAL_REPORT="D:\code\dsh-a2a\qa-artifacts\public-e2e-$(Get-Date -Format yyyyMMdd-HHmmss)"
node --import tsx scripts/public-e2e-server.ts
```

在第二个终端使用输出中相同的报告路径：

```powershell
$env:A2A_REAL_REPORT='<第一个终端输出的 report 路径>'
node scripts/record-public-e2e.mjs
node scripts/encode-public-e2e.mjs
```

录屏在真实 Portal 和明确标注的“本地测试观察台”之间切换。观察台展示实际 CLI 回复和断言，不是产品自带聊天页面。连续截图按真实时间编码 MP4，含章节字幕，无配音；另存一份只裁等待、不加速的精简版，并用 `highlights.json` 记录裁剪区间。Token 不出现在报告/画面中。`walkthrough.json` 保存断言、章节和失败原因，任务 ID 在发送后立即保存，超时只轮询 task，不自动重发。Windows 动态端口偶发被保留时，选择可用的 `A2A_REAL_AGENT_PORT`，不要关闭其他应用来抢占端口。

私有测试文件通过测试者在已启动的访客 VM 内生成，然后由真实 Agent 读取；这避免误把宿主机旧目录当成持续同步目录。私有 `/work` 的权威副本位于 VM 磁盘，首次导入后不会自动同步宿主目录新文件。

测试结束后先在该测试 Portal 中停止 Agent（触发沙箱刷盘），再结束测试 Connector、Portal 和 Relay。报告中 `info.json` 只保存测试路径、端口和 PID，不含凭据。临时环境中的凭据不应加入 Git。
