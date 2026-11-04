# Microsandbox 在 Windows 上的实测（2026-10-30）

结论：Microsandbox 0.7.11 已在本机 Windows 原生 WHP 上成功运行，具备成为 Docker 替代执行器的技术条件。共享目录只读、访客独立可写空间、Python 执行、生成文件导出及持久化均已验证。**当前建议作为可选实验执行器接入，暂不直接替换默认 Docker。** Windows 支持仍处于官方 preview 阶段，长期生命周期、并发、异常恢复和产物交付还需要产品集成验证。

本次没有修改生产执行器，没有升级或重启正在运行的 Portal、Relay、DSH。新增内容仅为独立实验脚本和报告。Microsandbox 安装在系统临时目录，没有添加到项目运行时依赖，也没有修改系统虚拟化配置。全部测试 VM 和对照容器均已删除，保留镜像缓存、实验结果和人工生成的样例。

## 环境与方法

- Windows 11 家庭中文版 x64，10.0.26200；Intel Core Ultra 9 185H，16 核 / 22 线程，约 32 GB 内存。
- Node 24.19.0；Microsandbox 0.7.11；Docker Engine 28.3.0。
- `msb doctor` 确认 WHP 可用；SDK 返回 `backendKind=local`。WHP 能力 API 返回成功，不需要管理员提权或重启。
- Python OCI 镜像 `docker.io/library/python:3.12-slim`；Python 3.12.16。Microsandbox 平台 manifest 与 Docker 多架构 index digest 记录于 [environment.json](microsandbox-windows-2026-10-30/environment.json)。两边下载的 4 个层摘要一致。
- 主对照均为 1 vCPU、512 MiB；禁用网络；公共资料只读、自己的目录可写；以 guest root 测试只读挂载的权限边界。Microsandbox 开启 `restricted`；Docker 禁用所有 capability、启用 no-new-privileges，根文件系统只读。两者不是完全相同的安全实现。
- 只使用新建的合成资料、访客 A/B、聊天日志和哨兵文件。**没有挂载或攻击真实用户资料、密钥、聊天记录。**
- 启动测 10 次；复用调用测 20 次；暂停/恢复测 10 次；串行运行，避免对照测试同时争抢资源。
- 计时从宿主 Node API / CLI 调用开始，到返回或首条 Python 命令完成；不含 LLM 请求、项目目录扫描、Portal 请求和文件网络下载。

## 实测速度

下面采用完成全部用例的第二轮结果；第一轮独立记录也保留，数值相近。

| 操作 | Microsandbox 中位数（范围） | Docker 对照中位数（范围） |
| --- | --- | --- |
| 镜像已缓存，新建并启动 | 387 ms（385–404） | CLI：390 ms（348–447） |
| 新建、启动并完成首次 Python 读文件 | 511 ms（507–533） | CLI：713 ms（668–785） |
| 复用实例，启动 Python 读文件并返回 | 29 ms（26–33） | CLI：322 ms（297–347） |
| 复用实例，直接调用 Docker Engine API | — | 143 ms（125–218） |
| 暂停仍驻留的 VM | 8 ms（7–25） | 未测试 |
| 恢复仍驻留的 VM | 5 ms（4–6） | 未测试 |
| 恢复并完成 Python 读文件 | 33 ms（31–36） | 未测试 |
| 删除实例 | 107 ms（92–113） | CLI：266 ms（258–378） |

第一次从空缓存下载、准备约 41 MiB 镜像并启动，共 137 秒。此数字主要受首次准备及网络影响，不能作为日常启动速度。首次 npm 安装另用了约 2 分钟，不计入任何上表数值。

第一轮：创建中位数 404 ms、创建并读文件 534 ms、复用读文件 28 ms、恢复并读文件 34 ms。**本机没有测到“从零创建完整可用沙箱只要 25 ms”；约 29 ms 是已运行沙箱中的一次轻量 Python 调用。**

Docker 复用 API 对照包含创建 exec、执行、查询退出状态三次本地 Engine 请求；CLI 对照还包含启动 docker.exe 的成本。因此不能把所有差距归因于虚拟化技术。当前项目实际使用 CLI，改用容器复用和 Engine API 也有优化空间。表中 Docker 的创建和首条命令为分开的调用，并非当前生产 `docker run --rm <command>` 整条路径的直接计时。

暂停是 resident pause，不代表释放全部内存或缩容到零。一个轻量 VM 的单次 runtime 指标显示宿主 resident 约 54 MiB、guest 使用约 41 MiB；不是整套应用总内存，也不是多访客负载下的容量保证。

## 权限与文件生成结果

主实验 79 个断言通过；其中包括现有项目的 2 个挂载预检断言。独立虚拟磁盘实验另有 8 个断言通过。**此外，原始可写 bind 的硬链接对抗试验暴露了边界，见下一节；不能将断言通过解释为任意目录裸挂载都安全。**

| 路径 | 权限 | 实测 |
| --- | --- | --- |
| `/public`：指定公共资料 | 只读 | Python 读取成功；覆盖、追加、新建、删除、重命名、移动、截断、创建/删除目录、chmod 均失败 |
| `/work`：当前访客私有空间 | 可增删改 | 创建、读取、覆盖、追加、重命名、删除成功 |
| 另一访客空间 | 不挂载 | A/B 分别执行，无法通过测试路径读取对方；宿主机对方目录内容和结构未变化 |
| 聊天记录、未共享宿主目录 | 不挂载 | Linux 路径、父目录穿越和已知 Windows 绝对路径读不到哨兵；宿主内容未变化 |
| 沙箱自身 `/tmp` | 沙箱内可写 | 只写入 VM 的私有文件系统 |
| 宿主环境变量、Docker socket | 不传入 | 测试环境变量不继承，socket 不存在 |
| 网络 | 禁用 | 到公网的测试连接失败 |

还测试了 guest 符号链接指向公共文件、把公共文件硬链接到私有目录、root 尝试重新挂载公共目录为可写，均未突破只读边界。检查了宿主文件内容 SHA-256 和目录结构，公共资料、聊天哨兵、未挂载文件保持不变。

文件生成闭环已跑通：Python 生成包含中文和二进制字节的文件 → SDK 读取内容返回 → `copyToHost` 导出到实验专用本地目录 → SHA-256 一致。可写 bind 的文件在销毁 VM 后仍存在，并且新 VM 重新挂载后可以读取。

这意味着“保护本地磁盘”应精确定义为：**公共资料及未授权宿主路径不可被访客改动；明确授权的访客空间或受控导出目录允许保存文件。** 沙箱镜像、状态和私有虚拟磁盘本身也必然占用宿主磁盘。不能同时要求所有宿主磁盘字节绝不变化，又要求生成文件本地持久化。

## 硬链接边界：不能直接裸挂载任意 Windows 可写目录

在另一个纯人工目录里预先建立：

```text
adversarial-mount/hardlink.txt ── 同一个文件对象 ── adversarial-outside/hardlink-target.txt
adversarial-mount/junction/   ── 目录联接 ─────── adversarial-outside/
```

将 `adversarial-mount` 可写挂载后：

- Windows junction：guest 读取和写入均被拒绝，返回 `ELOOP`。
- Windows 硬链接：guest 能读写 `hardlink.txt`，目录外同一文件对象的内容也随之改变。
- 这是共享文件对象的别名语义，不等同于 guest 任意访问整个宿主盘。测试没有接触任何真实用户文件。
- 项目现有 `verifyMountTree` 实测拒绝了硬链接和 junction。但是挂载前扫描本身不消除“宿主机在扫描后或长期挂载期间加入新链接”的竞态，不能据此宣称绝对路径隔离。

只读公共挂载会阻止通过该挂载写入，但预先包含外部硬链接的公共目录仍可能泄露外部内容；如果同一文件对象又经可写别名挂载，也不能靠另一处只读挂载保护。因此公共目录仍需拒绝链接，或构建经过校验的只读资料快照。

## 更适合本项目的存储模型

建议保留路径级权限设计，并优先用独立私有磁盘替代宿主可写目录直通：

```text
指定公共资料 ── 预检 / 安全快照 ── /public（只读）
访客 A 的独立虚拟磁盘 ────────── /work（可增删改，仅 A）
访客 B 的独立虚拟磁盘 ────────── /work（可增删改，仅 B）
后端聊天记录与凭据 ──────────── 不挂载
访客产物 ── 后端校验身份和文件 ── 本地 exports/<peer>/<artifact> + 下载响应
```

本次已额外验证 `owned({kind:'disk', sizeMib:128})`：创建 526 ms（单次，非统计值）；读写私有文件、禁止修改/删除公共文件、禁止跨挂载硬链接、文件导出都成功。停止后重新启动仍能读到私有文件；销毁 VM 后，之前导出的宿主文件仍存在。

注意：`owned` 磁盘在销毁 sandbox 时一起删除。生产中可以保留 sandbox 的持久身份，仅 stop/start；如果要独立回收 VM，则应采用独立持久磁盘卷，且每个访客卷只允许一个 VM 写入。独立命名磁盘卷的生命周期本次未测试，不能直接套用 `destroy` 作为空闲回收逻辑。

生成文件的产品交付还需实现：按认证后的 peer 定位产物、固定导出根目录、校验普通文件与大小、拒绝路径穿越/链接、限制总空间、原子落盘及授权下载。当前脚本只验证了传回字节和本地持久化能力，Portal/A2A 的附件入口没有在本次新增。

## 替换决策与剩余验证

建议增加可选 `microsandbox` 执行器，先保持现有 Docker 可用。访客第一次真正调用工具时启动，同一访客后续工具复用自己的 VM；纯聊天不创建 VM。不能跨访客复用同一个包含私有数据的实例。短空闲可暂停，较长空闲 stop，数据生命周期和运行实例生命周期分别管理。

上线前仍需完成：取消/超时后的进程回收、Portal/DSH 重启后恢复映射、并发上限、满盘与资源耗尽、异常退出/断电恢复、长时间运行、不同 Windows 机器、安装升级与镜像校验。若后端不可用，必须失败关闭，不能偷偷回退到宿主 Python/shell 执行。这些尚未做集成测试；本次也不是内核漏洞、虚拟机逃逸的完整安全审计。

官方明确 Windows 当前为 preview，使用 WHP/libkrun：[Windows 文档](https://raw.githubusercontent.com/superradcompany/microsandbox/main/docs/troubleshooting/windows.mdx)。只读挂载由宿主侧执行、默认只暴露镜像和显式挂载：[文件系统边界](https://raw.githubusercontent.com/superradcompany/microsandbox/main/docs/security/filesystem.mdx)。owned / named 磁盘及生命周期：[卷文档](https://raw.githubusercontent.com/superradcompany/microsandbox/main/docs/sandboxes/volumes.mdx)。文档可能随 main 分支变化，本次运行证据以固定 0.7.11 包和下列 JSON 为准。

## 补测：暂停和停止的真实资源差异

同日额外执行两轮生命周期实验，均为 1 vCPU / 512 MiB；其中一阶段让后台 Python 进程实际触碰并持有 128 MiB 内存。以下是第二轮 **Windows 完整 msb.exe 进程**的读数，不含共用的 Node 控制进程，不是上文的 guest backing 指标。

| 状态 | VM 进程实体内存 Working Set | VM 进程提交内存 Private Bytes | VM CPU（单核百分比，短样本） | sandbox 持久目录实际存储 |
| --- | --- | --- | --- | --- |
| 运行，轻载 | 133.32 MiB | 543.84 MiB | 2.99% | 4.44 MiB |
| 暂停，轻载 | 133.69 MiB | 543.84 MiB | 样本内 0% | 4.44 MiB |
| 运行，Python 持有额外 128 MiB | 258.23 MiB | 543.95 MiB | 11.12% | 4.44 MiB |
| 暂停，同一 Python 进程仍驻留 | 258.21 MiB | 543.85 MiB | 样本内 0% | 4.44 MiB |
| 停止 | VM 进程退出 | VM 进程退出 | 0% | 4.50 MiB，保留 |

第一轮对应实体内存约 136 MiB / 261 MiB，结论相同。测量用 Windows `WorkingSet64`、`PrivateMemorySize64` 和累计进程 CPU 时间；每阶段取两次进程快照，间隔至少 2 秒。后台 Python 每 100 ms 更新一次合成计数文件，加载阶段并非纯静态 idle。CPU 是短窗口观测，不是长期稳定负载基准。

磁盘以 Windows `GetCompressedFileSizeW` 测量 sandbox 持久目录中的文件，基础镜像缓存、宿主 bind 内容和共享运行时缓存不在此数值内。默认 root 上层逻辑长度 4 GiB，但此轻量案例实际存储约 4.5 MiB，不能将逻辑长度当成已占磁盘。真实访客写入越多，持久磁盘占用越大。暂停和停止均不删除这些文件。

**暂停的主要作用是停止执行、快速续跑，不是释放内存。** 配置 512 MiB 时，即使实际驻留仅 133 MiB，Windows 仍记录约 544 MiB 提交内存；规划并发容量需同时考虑内存提交额度。停止后 msb.exe 进程消失，但共用的 Node 控制进程仍占约 76 MiB；这不代表整个应用内存降为零，也不能将共用控制进程重复计入每个访客。

一个观测陷阱：这个版本的 SDK 在 paused 状态返回的 `memoryHostResidentBytes` 为 0，而 Windows 进程内存没有释放。因此暂停资源统计必须看宿主进程，不能直接把 SDK 的该字段解释为“零内存”。

生命周期断言均通过：暂停期间后台计数不增长；恢复后同一个 Python 进程继续；停止再启动后旧 Python 进程没有恢复；已写入磁盘的文件保留。两轮 stop 约 100–104 ms，重新 start 约 407–442 ms；这些为单次操作观测，不替代前文的 10 次启动基准。

按官方定义，pause 是驻留冻结，不生成休眠快照；stop 关闭 VM 及其进程，保留配置和文件系统，后续 start 重新启动 VM。停止已暂停的 VM 前需要先 resume。`stopWithTimeout` 超时不自动强杀，执行器必须明确处理超时状态。[官方生命周期文档](https://raw.githubusercontent.com/superradcompany/microsandbox/main/docs/sandboxes/lifecycle.mdx)（通过 gstack `/browse` 核对）。

产品策略建议：按认证后的 peer 维持持久身份和私有空间，首次工具调用才启动；同一 peer 有活动工具或后台任务时不自动暂停。可以在全部工具结束后空闲约 30 秒暂停、约 10 分钟停止；这是待接入的建议值，不是已经启用的默认配置。内存紧张时优先停止无任务的实例。共享同一访客凭据的人会落到同一 peer，不能据此隔离不同自然人。

补测脚本：`scripts/probe-microsandbox-resources.mjs <临时 lab>`。两次实验均已销毁测试 sandbox，最终 `msb ls` 返回空。详见 [资源补测 JSON](microsandbox-windows-2026-10-30/resources.json) 和 [第一轮补测 JSON](microsandbox-windows-2026-10-30/resources-initial.json)。

## 复现与证据

在仓库根目录 PowerShell 中执行；先安装项目依赖并构建现有隔离预检代码。实验只接受系统临时目录内的 lab，不执行自动提权、删除用户目录或修改生产配置。

```powershell
pnpm build
$msbLab = Join-Path ([IO.Path]::GetTempPath()) ('a2a-microsandbox-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $msbLab | Out-Null
npm install --prefix $msbLab --save-exact --no-audit --no-fund microsandbox@0.7.11 --registry=https://registry.npmjs.org
$env:MSB_HOME = Join-Path $msbLab 'runtime'
& (Join-Path $msbLab 'node_modules/.bin/msb.cmd') doctor
& (Join-Path $msbLab 'node_modules/.bin/msb.cmd') pull docker.io/library/python:3.12-slim
node scripts/probe-microsandbox.mjs $msbLab
# 将结果输出里的 run-* 目录填入下面变量：
$msbRun = Join-Path $msbLab 'run-实际编号'
docker pull python:3.12-slim
node scripts/probe-docker-baseline.mjs $msbRun
node scripts/probe-microsandbox-private-disk.mjs $msbLab $msbRun
```

实际镜像摘要已记录；未来 tag 可能变化，复现时须核对摘要。主实验会故意修改 lab 内的硬链接哨兵来测边界，报告中 `rawBindSafeWithoutPreflight:false` 是重要结果。脚本退出码反映常规配置断言，不能代替读取这个对抗结果。

- [Microsandbox 主结果](microsandbox-windows-2026-10-30/microsandbox.json)
- [第一轮原始结果](microsandbox-windows-2026-10-30/microsandbox-initial.json)
- [Docker 对照](microsandbox-windows-2026-10-30/docker.json)
- [私有磁盘结果](microsandbox-windows-2026-10-30/private-disk.json)
- [实际生成并导出的文本](microsandbox-windows-2026-10-30/generated-example.txt)

证据中的临时路径已用 `<LAB>` 替代；运行数据和时间未改动。实验脚本位于 `scripts/probe-microsandbox.mjs`、`scripts/probe-microsandbox.py`、`scripts/probe-docker-baseline.mjs` 和 `scripts/probe-microsandbox-private-disk.mjs`。
