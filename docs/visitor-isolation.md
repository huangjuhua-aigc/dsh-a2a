# 访客独立沙箱（0.4.0）

Portal 默认使用 Microsandbox 0.7.11，本机运行微型虚拟机。DSH 后端负责认证、模型调用和聊天记录；工具运行在访客沙箱中。当前模型仍只开放 `read_file`，没有自动开放 Python、Shell 或写入工具。私有目录读写能力已经由真实 Python 测试验证，可供以后受控开放的工具使用。

## 启动体验

点击 Portal「启动」即可自动检查/更新插件、下载固定版本的沙箱组件和固定摘要的 Python 镜像，页面显示进度。组件安装到用户目录并缓存，不需要手动安装 Microsandbox 或 Docker。纯聊天不创建访客 VM；首次工具调用才创建，后续调用复用。

支持的宿主环境：Windows x64/ARM64 + WHP、Linux x64/ARM64 + KVM、Apple Silicon macOS + ARM64 Node.js；Node.js 22 以上。当前只在 Windows x64 实测，其他平台需要单独验收。Intel Mac 暂不支持。

Windows 未启用“Windows 虚拟机监控程序平台”时，需要用户启用系统功能并重启。Linux 需要 /dev/kvm 访问权限。管理员权限、BIOS 设置和系统重启无法静默代办。准备失败会显示原因，重试复用已下载内容，绝不退回宿主机执行工具。

Portal 使用 npm 插件 `dsh-a2a-server@^0.4.0`。仅在测试本地源码时：

```powershell
# D:\code\dsh-a2a
pnpm install
pnpm build
# 在启动 Portal 的同一个终端里指定源码包位置
$env:A2A_PLUGIN_SOURCE='D:\code\dsh-a2a'
# 然后启动 Talk2MyAgent Portal
```

使用 npm 版本无需设置这个开发变量。独立 DSH 配置使用 `isolation.execution: microsandbox`；旧配置未填写时仍是 `read-only`，仅有受限读取器，没有 VM 边界。`docker` 作为兼容选项保留。

## 目录与持久化

| 内容 | 沙箱可见范围 | 本地保存 |
| --- | --- | --- |
| 用户指定公共资料 | /source，只读副本 | 原始目录不挂入 VM；包括公开简报 .hop/handoff.md |
| 当前访客的文件 | /work，可增加、修改、重命名、删除 | 每个访客独享持久化虚拟磁盘 |
| 其他访客的文件 | 不挂载 | 各自独立磁盘 |
| 聊天记录、协议状态、凭据 | 不挂载 | 可信 DSH 后端独立保存 |

Portal 的私有根在 `~/.a2a/workspaces/<agent>`。其 `.microsandbox/<peer>/record.json` 保存访客到 VM 的稳定映射，`public/` 保存公共资料副本；原有 `<peer>/` 文件作为首次导入源保留。以后 /work 中的新文件保存在虚拟磁盘中，**不会同步回旧的宿主机普通文件夹**。

运行组件与所有 VM 磁盘默认保存在 `~/.a2a/sandbox-runtime`；可在启动前通过 `A2A_SANDBOX_HOME` 指定。备份需同时包含私有根的映射和 runtime 的 state 目录。不要清除这些目录，或对用户 VM 执行 destroy/remove；这些操作会删除磁盘。用户生成文件的独立下载/导出入口尚未增加。

公共资料会在工具调用前验证并复制；内容更新时停止该访客旧 VM、更新只读副本，然后以原私有磁盘启动。复制最多 512 MiB、100000 项，大目录会增加调用耗时。Microsandbox 的公共资料副本自动排除各层级的 `node_modules`（不区分大小写），包括同名依赖链接；不会遍历其内容，也不会移动或删除原项目的依赖。其他硬链接、符号链接/junction、特殊文件和嵌套文件系统仍被拒绝，避免通过别名访问宿主机其他资料。私有工作区导入和 Docker 原目录挂载不使用此排除规则，仍拒绝所有链接。

隔离单位是 **agent + 已认证 peer**，不是每轮消息或 contextId。不同聊天共享同一 peer 的文件；多人共用访客令牌也会共用沙箱。每人应分配独立凭据。删除凭据不会自动删除旧文件。

## 生命周期

- 第一次调用工具：创建该访客 VM；聊天本身不创建。
- 工具完成后空闲 30 秒：暂停，保留进程和内存；暂停不释放主要内存。
- 自最后一次工具完成空闲 10 分钟：停止 VM，释放运行资源；磁盘与文件保留。
- 暂停期间来新工具请求：恢复原 VM；停止后再来：用原磁盘重新启动。
- 有工具执行或排队时不暂停；同一访客工具串行，不同访客各用自己的 VM。
- 每个后端最多 4 个驻留 VM（包括暂停的）；满额先停止最久未使用的空闲 VM。都忙时拒绝新增工具，已有文件不丢失。
- 正常关闭后端会停止其 VM；控制进程意外退出后，下次启动回收其记录的遗留实例。不会销毁用户磁盘。机器断电/强杀与普通磁盘一样可能丢失未落盘写入。

每个 VM 为 1 CPU、512 MiB 内存、256 MiB 根磁盘、512 MiB 私有工作盘，无网络，工具以 UID 1000 运行，单次执行限时 30 秒、输出 256 KB。公共副本只读且 noexec/nosuid/nodev；私有盘 nosuid/nodev。宿主用户、虚拟化实现与受信镜像仍属于可信边界，这不是对虚拟化漏洞的绝对保证。

`read_file({"path":"info.txt"})` 读公共资料；`read_file({"root":"workspace","path":"."})` 读自己的工作区。文件限 UTF-8 文本、2 MiB、单次 32000 字符与 500 行/项。后端聊天记录不作为可读工具目录。

## 旧数据迁移

停止旧 agent，再用新版 Portal 启动。Portal 把公共目录中的当前访客旧目录复制到独立私有根，校验后移除旧目录；目标已存在则拒绝覆盖。首次 VM 启动再导入自己的私有文件，冲突拒绝覆盖。已删除访客留下的历史私有文件需要主人移出公共资料目录。

公开简报继续默认定时更新到 .hop/handoff.md 并显示在 Portal。主人简报任务是可信后端任务，仍在宿主机执行，不属于访客沙箱。

## 测试

```sh
pnpm typecheck
pnpm test
pnpm test:package
pnpm test:microsandbox
```

最后一项会自动准备真实 Microsandbox，使用合成文件测试只读公共资料、私有 CRUD、跨访客隔离、链接攻击、网络/凭据隔离、取消、暂停/恢复/停止、重启和遗留实例回收。不会读取真实用户资料。

设置 `A2A_MSB_WALLCLOCK=1` 再运行，可执行完整 10 分钟真实计时测试；否则通过可控时钟触发真实 VM 的生命周期转换。`A2A_MSB_TEST_RUNTIME` 可复用一个测试 runtime 缓存。Docker 兼容验证仍用 `pnpm test:docker`（需本地 Linux Docker 和 docker/Dockerfile 构建的镜像）。
