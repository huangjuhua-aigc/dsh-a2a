# A2A 公网中继关键流程伪代码

更新日期：2026 年 10 月 30 日。状态：设计参考，实际代码已实现。先读[架构设计](a2a-relay-architecture.zh-CN.md)，实现位置与验证结果见[实现记录](a2a-relay-implementation.zh-CN.md)。

以下使用 TypeScript 风格表达控制流程、状态归属和错误处理，不是可运行实现。`store`、`locks`、`privateIpc`、`boundedWire` 等为设计抽象；对应的服务入口、SQLite 存储、IPC 管理和有界传输已在独立 Relay 与 Talk2MyAgent 仓库实现。

## 1 数据与协议约定

```typescript
type LocalPublication = {
  localAgentId: string
  providerId: 'default' | 'custom' // 默认由发行配置提供，也允许自定义 host
  relayOrigin: string
  localRpcUrl: string
  localCardUrl: string
  registrationId?: string     // 首次自动注册时生成，重试复用
  publicationId?: string      // 以下绑定字段在注册成功后才存在
  deviceId?: string
  credentialRef?: string
  publicRpcUrl?: string
  publicCardUrl?: string
  desiredEnabled: boolean
  intentRevision: number       // 本机持久化单调递增；同一设备绑定不能回退
  operationId: string         // 一次控制操作的稳定 ID，重试复用
  cloudSyncPending: boolean
}

type RuntimeIdentity = {
  pid: number
  processStartedAt: string
  executablePath: string
  instanceId: string
  ipcPath: string
}

type Session = {
  publicationId: string        // 从设备认证结果取得
  connectionId: string
  generation: number          // 云端持久化分配
  ready: boolean
  closed: boolean
  requests: Map<string, Inflight>
}

// 所有帧都有 v、connectionId、generation；认证之前不接收业务帧。
type Frame =
  | { type: 'ready'; cardAdapter: 'a2a-1-jsonrpc' }
  | { type: 'ready_ack' }
  | { type: 'request_begin'; requestId: string; route: 'card' | 'rpc';
      headers: AllowedRequestHeaders; timeoutMs: number; responseWindow: number }
  | { type: 'request_data'; requestId: string; seq: number; base64: string }
  | { type: 'request_end'; requestId: string; totalBytes: number }
  | { type: 'response_begin'; requestId: string; status: number;
      headers: AllowedResponseHeaders }
  | { type: 'response_data'; requestId: string; seq: number; base64: string }
  | { type: 'response_end'; requestId: string; totalBytes: number }
  | { type: 'response_credit'; requestId: string; consumedTotal: number }
  | { type: 'abort'; requestId: string; reason: TransportErrorCode }

const limits = {
  requestBytes: 1_000_000, headerBytes: 16 * KiB,
  chunkBytes: 64 * KiB, encodedFrameBytes: 128 * KiB,
  responseWindow: 256 * KiB, cardBytes: 1 * MiB,
  perPublicationInflight: 8, globalInflight: 64,
  websocketQueuedBytes: 1 * MiB,
  bodyReadMs: 15_000, responseHeadersMs: 90_000,
  responseIdleMs: 45_000, totalRequestMs: 600_000,
  heartbeatMs: 20_000, peerDeadMs: 45_000,
}
```

服务端和 Connector 都校验帧版本、类型、大小、状态顺序、seq 和累计字节数。Connector 在 request_begin 时就占用请求名额，之后才能分配请求体预算；收到一个完整请求前不调用本地 A2A。固定的 in-flight 名额、字节预算和有界发送队列共同限制内存；不能先分配任意大缓冲再检查大小。

`response_credit.consumedTotal` 是累计确认数。重复 credit 不重复增加额度；确认数必须单调，且不能超过已发送字节数。每条流独立处理帧顺序，多条流并发，不能在 WebSocket 总回调里等待一个完整的模型请求。

## 2 Connector 自动注册

默认 Relay 地址由维护者预置，用户也可填写自定义 host；两者共用相同接口，没有手动配对步骤。这个接口注册设备能力，不证明用户的真人身份；管理员凭据不下发到开源客户端。

```typescript
async function ensureRegistered(cfg, signal) {
  if (hasStoredBinding(cfg)) return cfg // 失效绑定也保留，不能换身份绕过封禁
  validateRelayOrigin(cfg.relayOrigin)
  await requireCredentialDirectoryOutsideAllConfiguredReadRoots(cfg.localAgentId)
  // 先持久化再发请求；响应丢失或进程重启不会生成第二套凭据。
  const pending = await privateStore.getOrCreateRegistration({
    agentId: cfg.localAgentId, relayOrigin: cfg.relayOrigin,
    registrationId: uuid(), deviceSecret: randomBytes(32),
  })
  const binding = await httpsNoRedirects(cfg.relayOrigin, '/v1/agents/register', {
    registrationId: pending.registrationId,
    deviceTokenHash: sha256(pending.deviceSecret),
    displayName: safeAgentDisplayName(cfg.localAgentId),
    protocolVersion: '1.0',
  }, { signal })
  validateReturnedBinding(binding, cfg.relayOrigin)
  // 只更新注册字段，保留并发变化的 desiredEnabled/intentRevision。
  // 配置 origin 已变化时拒绝写入，不能把旧服务器凭据关联到新服务器。
  await privateStore.commitBindingIfOriginMatches(cfg.localAgentId, pending, binding)
  return store.readPublication(cfg.localAgentId)
}

async function relayRegister(request) {
  requireSelfRegistrationEnabled()
  rateLimitRegistrationByIp(request)
  const input = parseSmallBoundedRegistrationBody(request)
  requireSupportedA2aProtocol(input.protocolVersion)
  return db.transaction(tx => {
    const existing = tx.registrationById(input.registrationId)
    if (existing) {
      requireSameDeviceHash(existing, input.deviceTokenHash)
      tx.requireNotBlockedOrRevoked(existing)
      return existing.publicBindingMetadata
    }
    tx.requireRegistrationCapacity()     // 活跃和未激活记录都占容量
    tx.requireDeviceHashNotBoundElsewhere(input.deviceTokenHash)
    const publication = tx.createPublication({
      enabled: false, ownerAccountId: null, displayName: input.displayName,
    })
    const device = tx.createDevice({
      publicationId: publication.id, tokenHash: input.deviceTokenHash,
      expiresAt: optionalDeploymentExpiry(), scopes: DEVICE_PUBLICATION_SCOPES,
    })
    const result = publicBindingMetadata(device, settings.publicOrigin)
    tx.saveRegistration(input.registrationId, input.deviceTokenHash, result)
    return result                       // 只返回 ID 和地址，不返回秘密
  })
}
```

同一注册响应丢失可以重试；不同令牌摘要不能接管已有注册。注册后暂不开放转发，设备设置发布意图并完成 WSS ready 后才在线。注册中途用户关闭时，结果可保存为未启用绑定，但不能继续开启；未激活的云端记录按部署策略清理。设备凭据丢失需要明确恢复流程，不能自动认领旧地址。

## 3 Portal 和 CLI 开启发布

Portal 先验证本地管理会话、Host、Origin 和 CSRF；CLI 使用私有 IPC。选择公网中继后调用同一控制函数，不要求第二次点击“配对/发布”。新建 agent 的向导在现有启动流程后自动调用它。配置修改和启停使用跨进程控制锁，Connector 的运行锁是另一把长期持有的锁。

```typescript
async function enablePublication(agentId) {
  return locks.withControlLock(agentId, async () => {
    const provider = resolveConfiguredRelayProviderForAgent(agentId)
    requireProviderEndpointConfigured(provider) // 实际域名由维护者后续提供
    let cfg = await store.loadOrCreatePublication(agentId, {
      providerId: provider.id, relayOrigin: provider.origin,
      ...detectConfiguredLocalA2aTargets(agentId),
    })
    await requireCredentialDirectoryOutsideAllConfiguredReadRoots(agentId)
    validateLocalTargetsAgainstCurrentMachine(cfg)

    cfg = await store.writeNextIntentAtomically(agentId, {
      desiredEnabled: true, operationId: uuid(), cloudSyncPending: true,
    })
    const alive = await verifiedConnectorIpc(agentId)
    if (alive) {
      requireSameRuntimeBinding(alive, cfg)
      return alive.status()             // 已启动则复用，不能重复 spawn
    }
    if (await locks.isRunLockHeld(agentId)) return { state: 'starting' }

    // spawn 的参数仅含配置引用；令牌不在命令行中。
    spawn(process.execPath, [connectorEntry, 'run', '--agent', agentId], {
      shell: false, detached: true, windowsHide: true, stdio: 'ignore',
    }).unref()
    // Connector 随后自动探测本地 agent、注册并连接；无手工中间步骤。
    // 超时返回 starting/registering/waiting_local，不能宣称发布成功。
    return waitForVerifiedStatus(agentId, { timeoutMs: 15_000 })
  })
}

async function setCloudEnabledWithDeadline(cfg, enabled) {
  return deviceControl(cfg, 'PUT', '/v1/publication/enabled', {
    enabled, intentRevision: cfg.intentRevision, operationId: cfg.operationId,
  }, { timeoutMs: 10_000, redirects: false })
}

async function relaySetEnabled(device, input) {
  return locks.withPublicationLock(device.publicationId, async () => {
    const result = await db.transaction(tx => {
      const binding = tx.requireActiveDeviceBinding(device)
      if (input.enabled) tx.requireNoAdminBlock(binding.publicationId)
      if (input.intentRevision < binding.lastIntentRevision) throw STALE_INTENT
      if (input.intentRevision === binding.lastIntentRevision) {
        requireSameOperationAndValue(binding, input)
        return binding.publication
      }
      const updated = tx.updateEnabledAndIntent(binding, input)
      return updated
    })
    // 此锁也保护握手、ready 和公开请求准入，不允许关闭期间新请求穿过。
    if (!result.enabled) closeCurrentSession(device.publicationId, PUBLICATION_DISABLED)
    return result
  })
}
```

intentRevision 由同一设备绑定的控制端持久化递增，云端也保存最后接受的值。后台只同步用户已经保存的待确认意图，不能在每次重连时生成新开启操作。晚到的“开启”不能覆盖更新的“关闭”。注册和连接由同一后台流程推进，Portal 轮询状态，不依赖浏览器页面替它执行下一步。

## 4 Connector 后台主循环

```typescript
async function runConnector(agentId) {
  const runLock = await locks.tryAcquireRunLock(agentId)
  if (!runLock) return                   // 并发 spawn 也只能有一个实际运行者
  const identity = makeRuntimeIdentity()
  const lifetime = new AbortController()
  let session: ConnectorSession | undefined
  let backoff = new JitterBackoff({ minMs: 1_000, maxMs: 30_000 })

  try {
    await privateIpc.listen(identity, {
      status: () => verifiedRuntimeStatus(identity),
      stop: () => { lifetime.abort(); session?.stopAcceptingAndClose() },
    })
    await store.writeRuntimeIdentityAtomically(agentId, identity)
    // 即使控制 IPC 丢失，也会周期性读取 desiredEnabled 并停止。
    startIntentWatcher(agentId, lifetime)

    while (!lifetime.signal.aborted) {
      let cfg = await store.readPublication(agentId)
      if (!cfg.desiredEnabled) break
      let endpoint
      try {
        endpoint = await probeLocalEndpointAndCard(cfg)
      } catch (error) {
        if (isPermanentConfigOrCardError(error)) {
          report('blocked', safeError(error)); break
        }
        report('waiting_local')
        await interruptibleDelay(3_000, lifetime.signal)
        continue
      }

      try {
        if (!hasStoredBinding(cfg)) report('registering')
        cfg = await ensureRegistered(cfg, lifetime.signal)
        cfg = await store.readPublication(agentId)
        if (!cfg.desiredEnabled || lifetime.signal.aborted) break
        if (cfg.cloudSyncPending) {
          await setCloudEnabledWithDeadline(cfg, cfg.desiredEnabled)
          await store.markCloudSyncedIfRevisionMatches(agentId, cfg.intentRevision)
        }
        cfg = await store.readPublication(agentId)
        if (!cfg.desiredEnabled || lifetime.signal.aborted) break
        report('connecting')
        session = await openAuthenticatedWss(cfg, {
          signal: lifetime.signal, protocol: 'a2a-relay.v1',
          compression: false, maxFrameBytes: limits.encodedFrameBytes,
        })
        // welcome 中公开 URL 必须与配置的 Relay 和绑定 ID 一致。
        validateWelcome(session.welcome, cfg)
        session.setFixedLocalTargets(endpoint)
        session.installBoundedRequestHandlers()
        await session.sendReadyAndWaitAck()
        report('online', session.publicUrls)
        backoff.resetAfterStableConnection(session, 60_000)
        // 监控心跳、授权期限和本地健康；本地不可用即停止准入并关闭隧道。
        const reason = await session.runUntilClosedOrLocalUnavailable(lifetime.signal)
        if (!lifetime.signal.aborted) {
          report(reason === 'local_unavailable' ? 'waiting_local' : 'reconnecting')
        }
      } catch (error) {
        if (isRevokedExpiredDisabledOrUnsupported(error)) {
          report('blocked', safeError(error)); break
        }
        report('reconnecting', safeError(error))
      } finally {
        session?.abortAllLocalHttpAndClose() // 不发 A2A CancelTask
        session = undefined
      }
      await interruptibleDelay(backoff.next(), lifetime.signal)
    }
  } finally {
    lifetime.abort()
    session?.abortAllLocalHttpAndClose()
    await privateIpc.close(identity)
    await store.removeRuntimeOnlyIfInstanceMatches(agentId, identity.instanceId)
    await runLock.release()
  }
}
```

进程异常退出的恢复由下次 Portal/CLI 启动协调完成；运行锁由 OS 释放。过期状态文件不能证明进程仍在运行，也不能作为强制终止其他进程的依据。

## 5 Relay 接受连接和防止旧连接覆盖

```typescript
async function onUpgrade(httpRequest, socket) {
  const device = await authenticateDeviceBearer(httpRequest)
  requireSupportedSubprotocol(httpRequest, 'a2a-relay.v1')
  await locks.withPublicationLock(device.publicationId, async () => {
    // 认证与拿锁间可能发生撤销，锁内再次检查。
    await db.requireEnabledActiveUnexpiredBinding(device)
    const generation = await db.nextConnectionGeneration(device.publicationId)
    const next = makeBoundedSession(socket, device, generation)
    const previous = sessions.get(device.publicationId)
    sessions.set(device.publicationId, next)
    previous?.closeAndFailInflight(CONNECTION_REPLACED)

    next.onReady(async frame => {
      await locks.withPublicationLock(device.publicationId, async () => {
        requireCurrentSession(next)
        await db.requireEnabledActiveUnexpiredBinding(device)
        validateReady(frame)
        next.ready = true
        await next.sendControl({ type: 'ready_ack' })
      })
    })
    next.onClose(() => {
      // 老连接关闭回调绝不能删掉新连接。
      if (sessions.get(device.publicationId) === next) sessions.delete(device.publicationId)
      next.failAndReleaseAllInflight(CONNECTION_LOST)
    })
    if (device.expiresAt) next.closeAt(device.expiresAt)
    next.startBoundedReadyDeadlineAndHeartbeat(limits)
    await next.sendWelcome(publicUrlsFor(device.publicationId), generation)
  })
}

async function revokeDevice(adminContext, deviceId) {
  requirePrivateAdminChannel(adminContext)
  const publicationId = await db.publicationForDevice(deviceId)
  await locks.withPublicationLock(publicationId, async () => {
    await db.revokeDevice(deviceId)
    closeCurrentSession(publicationId, DEVICE_REVOKED)
  })
}
```

单实例内，公开请求准入、设备撤销、开关变更与握手都经过同一发布锁。旧 generation 的帧直接丢弃；同一 generation 的非法帧按协议错误处理。已经发到本地 agent 的操作无法通过撤销撤回。

## 6 公网请求到本地 A2A

```typescript
async function handlePublicHttp(req, res) {
  const route = matchExactPublicRoute(req) // 仅 card GET 和 rpc POST
  if (!route) return httpError(res, 404, 'ROUTE_NOT_FOUND')
  const permit = await admission.tryAcquireBeforeReadingBody(route.publicationId, req.ip)
  if (!permit) return httpError(res, 429, 'RELAY_BUSY')
  let flow: Inflight | undefined
  try {
    const headers = validateAndFilterRequestHeaders(req.headers)
    const body = await readBytesWithinBudget(req, {
      limit: route.kind === 'card' ? 0 : limits.requestBytes,
      timeoutMs: limits.bodyReadMs, permit,
    })
    await locks.withPublicationLock(route.publicationId, async () => {
      await db.requirePublicationEnabledAndDeviceActive(route.publicationId)
      const session = requireReadyCurrentSession(route.publicationId)
      flow = session.registerFlow(uuid(), res, limits)
      // 连接与请求绑定；以后 session 被替换也不会把它迁到新设备连接。
      flow.bindCancellationToUnfinishedResponseClose(res)
      flow.installOrderedBoundedResponseHandlers()
      // 只入有界队列，不持有 publication 锁等待完整 HTTP 响应或 WS drain。
      flow.queueOwnedRequest(route.kind, headers, body, {
        beforeFirstFrame: () => { flow.mayHaveBeenDispatched = true },
        responseWindow: limits.responseWindow,
      })
    })
    await flow.waitForCompletionOrDeadline()
  } catch (error) {
    flow?.abortTransport(safeTransportCode(error))
    if (!res.headersSent) {
      httpError(res, transportHttpStatus(error), safeTransportCode(error), {
        outcome: flow?.mayHaveBeenDispatched ? 'unknown' : 'not_dispatched',
      })
    } else if (!res.writableFinished) {
      res.destroy()                      // 不往 SSE 插入一个普通 JSON 错误
    }
  } finally {
    flow?.cleanupOnce()
    permit.releaseOnce()
  }
}

// Connector 的每流处理器。data/end/abort 先经过序号及大小校验。
async function handleCompletedTunnelRequest(session, request) {
  requireCurrentGenerationAndReady(session, request)
  const permit = request.inflightPermit // request_begin 已取得，包含请求组装阶段
  const abort = request.transportAbortSignal
  try {
    const target = session.fixedTargets[request.route] // 无远程指定 URL
    const requestMethod = classifyJsonRpcMethodIfNeeded(request.body)
    const upstream = await boundedLocalHttp(target, {
      method: request.route === 'card' ? 'GET' : 'POST',
      headers: filterRequestHeadersAgain(request.headers),
      body: request.body, redirects: false, signal: abort,
      acceptEncoding: 'identity', limits,
    })
    rejectRedirectsAndUnsupportedEncoding(upstream)
    if (request.route === 'card' && upstream.status === 200) {
      const original = await readBoundedJson(upstream, limits.cardBytes)
      const adapted = adaptCard(original, session.publicRpcUrl)
      await sendBufferedJsonWithCredit(session, request, upstream, adapted)
    } else if (requestMethod === 'GetExtendedAgentCard' && isJson(upstream)) {
      const envelope = await readBoundedJson(upstream, limits.cardBytes)
      // JSON-RPC error 原样返回；成功结果才适配卡片。
      if (envelope.result !== undefined) {
        envelope.result = adaptCard(envelope.result, session.publicRpcUrl)
      }
      await sendBufferedJsonWithCredit(session, request, upstream, envelope)
    } else {
      await sendRawResponseWithCredit(session, request, upstream)
    }
  } catch (error) {
    session.abortRequest(request.id, safeTransportCode(error))
  } finally {
    request.abortAndReleaseLocalResourcesOnce()
    permit.releaseOnce()
  }
}

function adaptCard(card, publicRpcUrl) {
  requireSupportedUnsignedCard(card)
  const copy = structuredClone(card)
  copy.supportedInterfaces[0].url = publicRpcUrl
  return copy // 认证声明、技能、能力和版本保持不变
}
```

`classifyJsonRpcMethodIfNeeded` 只识别卡片查询用途，不实现 A2A 业务分发；无效 JSON 仍由本地 A2A 返回协议错误。适配卡片时需要移除失效的 Content-Length、ETag 和摘要头。认证失败响应不能被卡片适配改成成功响应。

## 7 SSE 和响应背压

```typescript
async function sendRawResponseWithCredit(session, request, upstream) {
  await session.sendControl(responseBegin(request.id, upstream.status,
    filterResponseHeaders(upstream.headers)))
  let sentTotal = 0, seq = 0
  // boundedReader 必须尊重 credit，且内部读取缓存有界。
  const reader = boundedReader(upstream, limits.chunkBytes)
  while (true) {
    const allowance = await request.credit.waitAvailable(request.transportAbortSignal)
    const lease = await session.memory.reserve(Math.min(allowance, limits.chunkBytes))
    try {
      const bytes = await reader.readAtMost(lease.size)
      if (bytes === EOF) break
      request.credit.consume(bytes.length)
      // Base64 额外内存和 WS 原生 bufferedAmount 也纳入发送预算。
      await session.boundedFairSender.sendData(request.id, seq++, bytes)
      sentTotal += bytes.length
    } finally { lease.release() }
  }
  // 该流 data 全部发送完成后才能 end；不能被控制帧优先级越过。
  await session.sendOrderedEnd(request.id, sentTotal)
}

async function onRelayResponseData(flow, frame) {
  requireFrameForExactSessionAndFlow(flow, frame)
  requireNextSequenceAndResponseStarted(flow, frame)
  const bytes = strictDecodeBase64WithinLimit(frame.base64, limits.chunkBytes)
  flow.credit.assertWithinAdvertisedWindow(bytes.length)
  flow.credit.recordReceived(bytes.length)
  if (!flow.httpResponse.write(bytes)) {
    await waitDrainOrAbort(flow.httpResponse, flow.abortSignal)
  }
  flow.credit.recordConsumed(bytes.length)
  await flow.session.sendControl({
    type: 'response_credit', requestId: flow.id,
    consumedTotal: flow.credit.consumedTotal,
  })
}

function onConnectorCredit(flow, consumedTotal) {
  requireMonotonicIntegerAtMost(consumedTotal, flow.sentRawBytes)
  flow.credit.setConsumedTotal(consumedTotal) // 重复值无额外额度
}

function onPublicClientDisconnect(flow) {
  flow.abortTransport('VISITOR_DISCONNECTED')
  // 中断本地 HTTP 订阅；绝不猜测 taskId 或代发 CancelTask。
}
```

HTTP 首个响应头、响应空闲和总时长分别计时。正常 SSE heartbeat 字节会刷新响应空闲计时。ping/pong 只证明隧道存活，不延长某个已无响应的业务请求。慢流的 credit 等待必须可被断线、停止和超时打断。

## 8 停止发布与恢复协调

```typescript
async function disablePublication(agentId) {
  return locks.withControlLock(agentId, async () => {
    let cfg = await store.writeNextIntentAtomically(agentId, {
      desiredEnabled: false, operationId: uuid(), cloudSyncPending: true,
    })
    const localStop = await stopVerifiedConnector(agentId)
    // 私有 IPC stop 先禁止新转发，abort 本地 HTTP，关闭 WSS，再应答退出。
    // 无响应时仅在 PID、启动时间、实例与程序身份全部核实后终止。
    // 无法核实就报告错误，不能杀一个碰巧占用旧 PID 的进程。
    let cloudStop = 'pending'
    try {
      cfg = await store.readPublication(agentId) // 注册可能在停止前刚返回
      if (hasStoredBinding(cfg)) await setCloudEnabledWithDeadline(cfg, false)
      // 没有绑定时从未启用云端；丢失响应造成的未激活注册不会提供转发。
      await store.markCloudSyncedIfRevisionMatches(agentId, cfg.intentRevision)
      cloudStop = 'confirmed'
    } catch (error) {
      await store.recordSafeSyncError(agentId, error)
    }
    return { localStop, cloudStop }      // 不把部分成功报告成全部完成
  })
}

async function reconcileWhenManagerStarts(agentId) {
  // 使用同一控制锁；不创建一个无限常驻的第二套 supervisor。
  await locks.withControlLock(agentId, async () => {
    const cfg = await store.readPublication(agentId)
    if (!cfg.desiredEnabled) {
      await stopVerifiedConnector(agentId)
      // 云端不可达不能阻止本机先停止；同步失败留待下次协调。
      if (cfg.cloudSyncPending && hasStoredBinding(cfg)) {
        await trySyncSameSavedIntentAndRecordError(cfg)
      }
      return
    }
    if (!hasStoredBinding(cfg)) {
      await ensureOneConnectorRunningWithoutChangingCloudIntent(cfg)
      return                              // 让后台继续原来的自动注册流程
    }
    if (cfg.cloudSyncPending) await syncSameSavedIntentIfAllowed(cfg)
    const cloud = await fetchOwnPublication(cfg)
    if (!cloud.enabled || cloud.revoked || cloud.expired) {
      reportToPortal('blocked', cloud.reason) // 不自动重新开启云端
      return
    }
    await ensureOneConnectorRunningWithoutChangingCloudIntent(cfg)
  })
}

async function stopManagedAgent(agentId) {
  const publication = await disablePublication(agentId)
  requireLocalForwardingStopped(publication.localStop)
  await existingDshRunner(agentId).stopAndVerifyExit()
}
```

关闭隧道不保证取消已执行的任务。关闭发布返回前，要核实 Connector 已停止接受请求；无法核实则明确返回停止失败。云端不可达导致的 pending 与本机停止失败是两种不同状态。

## 9 公网地址和邀请指令

注册成功只能得到地址，WSS ready 确认后才允许生成“现在可聊”的邀请。复用现有 `visitorInstruction()` 的安装、保存凭据、添加通讯录和发送问候步骤，地址由发布结果统一提供，不再从 LAN 配置推导。

```typescript
function resolveRelayProvider(selection) {
  if (selection.kind === 'default') {
    return { id: 'default', origin: validateRelayOrigin(releaseConfig.defaultRelayOrigin) }
  }
  const origin = normalizeHostToHttpsOrigin(selection.host)
  return { id: 'custom', origin: validateRelayOrigin(origin) }
}

async function createVisitorInvitation(agentId, peerName) {
  requireAuthenticatedLocalOwnerRequest() // Host/Origin/CSRF 与管理会话
  return locks.withControlLock(agentId, async () => {
    const cfg = await store.readPublication(agentId)
    const runtime = await verifiedConnectorIpc(agentId)
    const status = await runtime?.status()
    requireDesiredEnabledAndOnline(cfg, status)
    requireSameRuntimeBinding(runtime, cfg)
    validateReturnedPublicUrls(status, cfg.relayOrigin, cfg.publicationId)

    // 仅取明确允许访问且已应用到当前运行 agent 的访客；不新建共享访客。
    const peer = await localAgent.getAppliedVisitor(agentId, peerName)
    requireTrustedVisitor(peer)
    const visitorToken = await localCredentials.readVisitorSecret(agentId, peer.name)
    const templateData = {
      agentName: await localAgent.displayName(agentId),
      alias: safeContactAlias(agentId, peer.name),
      tokenEnv: visitorTokenReference(agentId, peer.name),
      visitorToken,
      rpcUrl: status.publicRpcUrl,
      cardUrl: status.publicCardUrl,
    }
    const text = renderExistingVisitorTemplate(templateData, {
      addArgs: ['add', templateData.alias, templateData.rpcUrl,
        templateData.tokenEnv, templateData.agentName,
        '--card-url', templateData.cardUrl],
      sendArgs: ['send', templateData.alias, '你好'],
      quoteArgumentsForRecipientShell: true,
    })
    return { text, cacheControl: 'no-store' } // 不记录正文，不包含任何设备/owner 凭据
  })
}

async function onCopyInvitationClick(agentId, selectedPeer) {
  // 每次点击重新生成，避免保留轮换前令牌或切换 Relay 前的地址。
  const invitation = await localOwnerApi.post(
    `/api/agents/${agentId}/publication/invitation`, { peerName: selectedPeer },
  )
  try {
    await navigator.clipboard.writeText(invitation.text)
    showCopiedState()
  } catch {
    showTransientSelectableInvitation(invitation.text)
  }
}
```

`--card-url` 是计划新增的访客 CLI 参数，目前尚未实现。它必须与复制模板同时交付，并保留无该参数时的原有使用方式。所有命令参数按实际目标 shell 引用，不能把未转义的 agent 名称直接拼成可执行代码。上面返回的邀请是一整段可交给访客 agent 的指令，访客不需要手动替换地址或凭据。

复制发生时仍在线不保证未来一直在线；接收方随后遇到离线时应得到明确错误。普通状态接口不包含访客令牌，生成邀请也不向 Relay 上传邀请内容或主动发送“你好”。

访客出站调用继续使用现有 A2A 技能及其 CLI。此次只补完整 Card URL 和邀请内容的地址替换，不新增 MCP bridge。Connector 直接连接受支持的原生 A2A 服务；闭源 agent 入站适配和通用 Agent Adapter 接口均不在本轮伪代码范围内。

## 10 辅助接口必须满足的约束

| 接口 | 必须满足的约束 |
| --- | --- |
| `privateStore` | 原子写入、权限/ACL、秘密不出普通状态 API、崩溃恢复和临时秘密清理 |
| `verifiedConnectorIpc` | 私有管道或 socket、调用者权限、实例身份核验、超时；不只检查 PID |
| 配置修改接口 | 绑定或目标变更前必须停止发布；更换 Relay 自动注册新绑定，不发送旧令牌；运行配置摘要一致才复用进程 |
| `resolveRelayProvider` | 默认入口来自维护者配置；自定义 host 规范化为 HTTPS；失败时不静默切换服务器 |
| 邀请生成器 | 只使用当前在线发布的 RPC/Card URL 和所选访客凭据；无 localhost 回退，无设备凭据，正确引用命令参数 |
| `boundedWire` / sender | 有界帧和发送队列、每流顺序、公平调度、控制消息预留空间、无无限 await 队列 |
| `authenticateDeviceBearer` | 检查摘要、绑定、scope、期限、撤销；日志不包含令牌 |
| `requireSupportedUnsignedCard` | 只接受已实现的 A2A 1.0 JSON-RPC 卡片形状；保留认证；不能静默删签名 |
| `admission` / memory | 请求在读取 body 前占位；全局、每发布及字节预算都要释放一次 |
| `cleanupOnce` | 取消计时器和监听、释放预算、移除请求；正常结束、超时、断线竞态下幂等 |
| `transportHttpStatus` | HTTP 层错误，不冒充本地 JSON-RPC 业务结果；错误信息无秘密或本机路径 |
| `locks` | 跨进程控制锁、进程运行锁、服务端每发布锁职责分离，明确获取顺序 |

首版云端只允许一个实例持有数据目录。进程和 SQLite 的单实例约束必须在启动时检查，不允许两个容器共享目录却各自维护一份连接表。

## 11 测试案例设计

这些是后续实现的测试要求，本轮没有运行它们。

| 场景 | 关键断言 |
| --- | --- |
| 未开启公网发布 | 没有 Connector；localhost A2A 正常 |
| Portal 与 CLI 同时开启同一 agent | 只有一个后台进程和一个有效云端连接 |
| 停止后旧开启请求才到云端 | intentRevision 拒绝旧意图，保持关闭 |
| 管理员关闭后设备重试开启操作 | adminBlocked 阻止开启，不能被设备清除 |
| 注册响应丢失 | 同一 registrationId 返回同一发布绑定；换摘要重试被拒绝 |
| 首次选择默认公网中继 | 自动启动 Connector、注册并连接；无需地址、配对码或第二次点击发布 |
| 自定义 host | 只向所选 Relay 注册；服务不兼容时给错误，不回退默认服务器 |
| 切换 Relay | 停止旧连接；不同 origin 的凭据隔离，不泄露旧令牌 |
| 注册或连接中关闭开关 | 新返回的绑定保持关闭，不生成邀请；旧开启意图不能覆盖关闭 |
| Relay 注册接口容量耗尽 | 返回限额错误，有界重试；不无限创建记录或在客户端内置管理员密钥 |
| 设备 A 声称设备 B 的 publicationId | 按认证绑定拒绝，不允许跨实例 |
| 旧连接 close/data 晚到 | 新连接仍在线；旧响应不进入新请求 |
| 设备到期或管理员撤销 | 已有连接关闭，不能靠保持 WSS 绕过到期 |
| 请求已被本地计数后隧道断开 | 本地执行计数为 1；重连不自动重发 |
| 访客断开 SSE | 订阅和预算释放；模型任务不被隐式取消 |
| 关闭 Portal 页面及其 Node 进程 | Connector 与本地 agent 继续可用 |
| 关闭发布且云端不可达 | 本地先停止；明确显示云端关闭待确认 |
| Connector 崩溃和 PID 被其他程序复用 | 不误杀；再次开启能恢复正确实例 |
| 本地 agent 停止或端口不可用 | 不报告在线，不转发到别的服务或随机端口 |
| LAN IP 监听、loopback 和 IPv6 | 使用正确本机目标；不接受远程目标和重定向 |
| 公共及扩展 Agent Card | 对外 RPC URL 正确；认证和技能不变；签名卡片明确拒绝 |
| 中文、emoji 刚好被分块截断 | 原始字节往返完全一致，不新增乱码或孤立 surrogate |
| 慢访客、无响应 agent、超大请求 | 按边界超时/拒绝；所有队列和内存维持预算 |
| 128 KiB 超限帧、超额 credit、乱序/end 重复 | 不突破额度；拒绝非法帧并完成资源清理 |
| 访问 Portal 路径、owner 管道、其他本地端口 | Relay 和 Connector 两端都不允许 |
| 恶意网页向 localhost 发发布请求 | Host/Origin/CSRF 和会话验证失败 |
| 新访客调用、任务查询和重新订阅 | 继续由本地校验 Bearer 和会话归属 |
| 日志与普通状态响应检查 | 无设备令牌、访客令牌或会话正文；邀请正文不进入日志 |
| 共享根包含 Connector 私有目录 | Portal 拒绝自动注册或发布；覆盖 peer 根、符号链接和目录调整 |
| 复制邀请及 CLI 接入 | 所有地址都为同一 Relay 发布地址；Card URL 保留完整前缀；接入和问候命令可用 |
| 访客令牌轮换或选择另一访客 | 复制最新且属于所选访客的令牌，不夹带 owner、设备或模型凭据 |
| 未在线、已关闭、权限未应用 | 复制按钮不可用；直接请求生成接口也失败，不生成 localhost 邀请 |
| 浏览器拒绝写剪贴板 | 显示同一份可选择指令供手动复制 |

UI 自动化应覆盖默认/自定义 Relay、注册中、在线、重连、授权失效、关闭待确认，以及完整的“选择 → 自动发布 → 复制邀请”流程；按钮反复点击不会重复启动。单元和集成测试采用模拟 A2A，真实跨网测试最后单独执行，不能用同机 loopback 测试替代公网验收。

原生兼容测试验证 Connector 无需 DSH 依赖即可连接符合约束的 A2A 服务。访客侧使用现有 A2A 技能完成邀请接入、发送和任务查询，不要求运行 Connector 或新增 MCP 组件。
