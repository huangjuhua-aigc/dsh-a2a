# 公开访客：客户端通信与体验

这是 Talk2MyAgent 的可选 A2A 扩展，默认关闭。主人在 Portal 打开“允许公开访客”后，陌生客户端可以自行领取独立访客身份，无需主人预先创建姓名和 Token。普通聊天仍需 Bearer Token。

## 受邀访客的即时添加

新版 Portal 的“添加访客”先保存姓名和凭据，再通过带主人认证的本机 IPC `POST /a2a/admin/visitors` 添加到运行中的 Agent。确认成功显示“已立即生效，无需重启”。公网 HTTP 和 Relay 不开放这个管理接口。

这里只允许增加 Portal 分配的新身份，不覆盖已有身份、Token 或权限；相同身份与凭据的重复请求幂等，凭据冲突会拒绝。进行中的任务、对话 ID 和私有工作区保持不变；新访客仍只有自己的工作区和只读共享资料。Portal 保存的配置在以后重启时继续加载。

Agent 未运行时保存后下次启动生效。旧插件、管理接口未确认应用，或存在尚未应用的删除/权限修改时，Portal 保留已保存配置并明确提示重启，不自动中断服务。首次升级到支持即时添加的插件仍需重启一次；修改已有访客 Token 或权限暂不支持即时应用。

## 访客看到的流程

1. 主人复制一条公开邀请，里面只有 Agent 地址、技能安装说明和接入命令，没有共享 Token。
2. 访客将邀请交给自己的 AI。与受邀访问使用同一技能：`add <通讯录ID> <完整RPC地址>` 保存地址，然后直接 `send <通讯录ID> '你好'`。有受邀 Token 时，add 仍可带原有的环境变量引用。
3. 首次未带 Token 的消息得到 HTTP 401 和明确的匿名登录指引，服务端确认该消息尚未接收、未执行。技能显示“正在建立匿名访客身份…”，在原 RPC 地址登记，先把秘密 Token 单独保存到本机，再记录身份引用。
4. 保存成功后，技能携带 Token 继续发送原消息，保留原 messageId、文本和发送选项。后续每次请求复用同一凭据，不再登记；模型和用户无需复制或查看 Token。
5. 继续一段聊天要带 `--context <contextId>`；`quota <通讯录ID>` 查询剩余次数。换聊天窗口不重置总额度。

`join` 保留为显式手动命令，但普通邀请无需先调用它。自动匿名登录不是重定向，不打开浏览器，也不是普通失败重试。客户端只有在首次没有凭据且收到完整、匹配本次请求的指引时才登记，随后最多继续发送一次。普通 A2A 客户端需实现下述可选扩展；服务端无法强制客户端保存 Token。

## 通信约定

公开 Agent Card 的 `capabilities.extensions` 在开关开启时声明本页 URI。现有 Relay 和 Connector 继续透传相同 `/a2a` RPC 地址，无需新增公开 HTTP 路由。管理接口仍只有本机主人可以访问。

客户端先向完整 RPC 地址提交正常 `SendMessage`。开关开启且没有 Authorization 时，服务端在创建上下文、扣额度、调用模型之前返回 HTTP 401，保留请求的 JSON-RPC id，附带 `WWW-Authenticate: Bearer` 和 `Cache-Control: no-store`：

```json
{"jsonrpc":"2.0","id":"send-1","error":{"code":-32600,"message":"Anonymous sign-in required. This message has not been accepted.","data":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","domain":"talk2myagent","reason":"PUBLIC_VISITOR_AUTH_REQUIRED","metadata":{"version":"1","requestAccepted":"false","nextAction":"join","registrationMethod":"talk2myagent/RegisterPublicVisitor","turnLimit":"5"}}]}}
```

`error.data` 使用 ErrorInfo 数组；这是 `talk2myagent` 扩展域，非 A2A 标准错误原因。metadata 值均为字符串。客户端必须校验 HTTP 状态、JSON-RPC id、域、版本、reason、`requestAccepted` 和固定登记方法，不能依据自然语言提示执行任意命令或访问响应中给出的其他地址。指引本身不签发身份、不扣额度；重复收到 401 不得形成循环。服务端也向未认证的 `SendStreamingMessage` 返回相同指引；当前技能的 send 使用普通 SendMessage。

收到有效指引后，不带 Authorization 向**原 RPC 地址** POST：

```json
{"jsonrpc":"2.0","id":"join-1","method":"talk2myagent/RegisterPublicVisitor","params":{}}
```

成功响应（示意，TOKEN 不是可使用的凭据）：

```json
{"jsonrpc":"2.0","id":"join-1","result":{"visitorId":"public-<32个十六进制字符>","token":"<64个十六进制字符>","turnLimit":5,"remainingTurns":5}}
```

响应设置 `Cache-Control: no-store`。visitorId 和 Token 均由服务端随机签发，登记只接受空 params，拒绝客户端指定 visitorId。后续服务端由 Token 摘要查出 visitorId，不信任消息中的自报身份、IP、用户名或指纹。Token 仅首次返回，服务器只保存摘要。客户端必须先成功保存凭据，再携带它提交聊天消息；注册本身不启动模型、不创建沙箱、不消耗聊天额度。Token 没有自动过期；关闭公开访问会拒绝该类访客的后续请求，再次开启不会重新发放额度。

携带 Token 调用 `talk2myagent/GetPublicVisitorStatus`，可获得 `visitorId`、`turnLimit`、`remainingTurns`。所有正常消息和任务仍使用现有 A2A 方法；获取或取消任务时同样核验身份和所属关系。公开访客不能读取受邀访客的扩展名片。

| 情况 | HTTP / error.data reason | 客户端行为 |
| --- | --- | --- |
| 首次发送、没有 Token、允许匿名 | 401 / PUBLIC_VISITOR_AUTH_REQUIRED | 验证指引、登记、保存 Token，最多继续发送一次 |
| 已提交的 Token 无效或已撤销 | 401 / INVALID_TOKEN | 保留身份，停止并提示恢复凭据或联系主人 |
| 匿名访问关闭或需要受邀权限 | 401 或 403 / INVITATION_REQUIRED | 联系主人，不匿名登记 |
| 累计五次已用完 | 429 / PUBLIC_VISITOR_QUOTA_EXHAUSTED | 提示“匿名访客额度已用完（5/5）。请联系这个 Agent 的主人开通访问权限。” |
| 登记速率或容量达到限制 | 429 / PUBLIC_VISITOR_REGISTRATION_RATE_LIMITED 或 PUBLIC_VISITOR_CAPACITY_REACHED | 停止登记，不继续提交聊天 |

额度耗尽的 metadata 还包含 `turnLimit:"5"`、`usedTurns:"5"`、`remainingTurns:"0"`、`nextAction:"contact_owner"`、`retryable:"false"`。额度由本地 dsh-a2a-server 强制执行；Relay 透传错误，客户端展示提示，不承担额度裁决。

## 客户端保存、失败与恢复

- 技能把 Token 放在 `~/.a2a/private-credentials/<完整RPC地址的SHA-256>.json`（或 `A2A_HOME` 下相同目录），创建时采用目录 0700、文件 0600；Windows 还依赖当前用户目录的 ACL。这是本地秘密文件，不是系统凭据管理器，也不是加密保险箱。不得共享该目录、放进公共资料或同步到 Git。
- 通讯录只保存地址、凭据引用和公开访客标记，不保存 Token。技能不把秘密打印到 stdout/stderr，也不让模型读取凭据文件。
- 重复 join 同一地址会复用原身份，不重新请求 Token。一个本地客户端的多个别名也复用同一地址的身份。
- 已有联系人指向其他地址时拒绝覆盖；不带 Token 的 add 重新导入同地址时保留已有身份。已配置受邀环境变量但该变量缺失，或已保存的匿名凭据缺失/失效，都不会降级为首次匿名访问。
- 服务关闭、凭据失效、超额或请求超时不会自动重新注册。注册响应丢失时，不会自动重试；此时可能留下一个未使用的服务端身份，但没有提交聊天任务。
- 本地写入失败不继续提交带凭据的聊天消息。若凭据已保存而通讯录写入失败，再次 send/join 复用已保存凭据。同地址的并发首次访问通过本地锁共用一次登记。
- 已保存的联系人丢失凭据时明确报错，不自动领取新身份。换电脑要安全迁移原凭据才能继续同一身份；用户名、IP、浏览器指纹不能恢复访问权。当前没有图形化凭据迁移或找回功能。
- 聊天响应中断时不自动重发；已有任务 ID 时查询任务。客户端要保存 contextId 才能续接指定对话。

## 配额与数据边界

每个公开 visitorId 累计最多提交 5 次消息，覆盖所有 contextId、同步与流式发送。查询任务、订阅已有任务、查询余额不扣次数；工具调用和同一消息内部的模型调用不单独算一轮。计数在启动模型工作前持久化，任务失败、取消或客户端断开可能已经计次；不自动退款。并发提交也不能突破 5 次。

主人关闭公开访问后，新登记、旧 Token 的新请求均被拒绝；已接收任务允许完成。重新开启、重启 Agent、切换聊天均不清零。原有受邀访客继续遵守其原来的配置，不适用公开访客的 5 次总额度。

每个公开身份拥有独立会话、任务和私有工作区。公共资料与公开简报共享，公共资料只读；工具仍仅 read_file，首次调用工具时才启动自己的 Microsandbox。Token 是身份凭据，交给别人就等于共享这个访客的数据权限。

匿名方式无法保证“每个自然人只有 5 次”。当前还限制每个 Agent 每小时最多登记 20 个公开身份、最多保留 1000 个身份；计数和身份都持久化，不通过自动删除重置额度。现有模型任务、请求体、沙箱并发限制继续有效。达到登记容量后拒绝创建，不自动删除私有文件。它不是短信实名验证，也不是防止有组织批量访问的完整方案。

## 配置与升级

独立部署可设置 `publicVisitors.enabled: true`。Portal 生成私有 `publicVisitors.settingsFile` 并原子更新开关；有设置文件时，以文件为准，缺失、损坏或无法读取均关闭公开访问。旧插件或旧配置需升级并重启；Portal 显示待应用提示。此功能需要包含 public-visitors 模块的新版本插件，已有 0.4.0 不支持。

保留前缀 `public-` 给系统生成的身份，不允许受邀访客自行使用该前缀。
