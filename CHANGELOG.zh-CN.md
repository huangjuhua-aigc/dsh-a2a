# 更新日志

[English](CHANGELOG.md) · [简体中文](CHANGELOG.zh-CN.md)

## 0.3.0

要求 DeepSeek Harness `>=0.2.1-rc.2 <0.3.0`，使用 A2A 1.0 JSON-RPC。

- 访客可以聊天，并通过 `read_file` 读取主人指定的资料目录。拦截路径越界、链接、插件私有状态及其他工具；公共模型提示与主人运行时上下文分离。
- 主人 RPC 和监控迁到需要认证的本机 IPC；公网 HTTP 仅接受访客凭据。空白名单 `trustedPeers: []` 拒绝全部访客。
- 限制并发、每日任务数、执行时限、模型调用、输出和流缓冲；同一 context 的并发请求不会串答，SSE 断开后释放订阅。
- 在保留期内持久化任务结果与空闲对话，支持驱逐和重启后的恢复。重启中断的任务标记失败，不自动重放。
- 增加由 Portal 配置的自动简报循环：默认每小时更新、一个持久化开关、重启去重，完成后直接写入 `.hop/handoff.md`。
- 补齐运行依赖声明，验证脱离开发依赖后可导入。保留上游流式解码异常的 Unicode 防护。

验证：15 个文件共 217 项测试、类型检查、构建和仅使用声明运行依赖的包导入检查。测试使用确定性模型；真实模型与跨网络部署需要单独验收。

### 升级

停止 agent，必要时升级 dsh，然后更新原有 profile 中的插件：

```sh
dsh plugin --profile YOUR_PROFILE add dsh-a2a-server@0.3.0
```

将 `YOUR_PROFILE` 替换为已保存的 profile 名称，安装后重新启动。配套 [Talk2MyAgent Portal](https://github.com/huangjuhua-aigc/Talk2MyAgent) 也需要更新，以使用私有管理入口和自动简报开关。升级已有 profile 时不要再次使用 `--from-default-profile`。

原来的 HTTP 主人/监控调用必须迁移至本机 IPC。部署前检查访客许可与资料目录，详见[迁移指南](https://github.com/huangjuhua-aigc/dsh-a2a/blob/main/docs/public-access-hardening.md)。
