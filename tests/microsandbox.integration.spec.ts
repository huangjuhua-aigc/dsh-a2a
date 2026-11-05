import { mkdir, mkdtemp, readFile, writeFile, realpath, symlink, link, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Config, type A2AServerConfig } from '../src/config.ts'
import { prepareIsolation } from '../src/isolation.ts'
import { MicrosandboxDriver, microsandboxReadTool, type MicrosandboxVM } from '../src/microsandbox-executor.ts'
import { VisitorSandboxes } from '../src/sandbox-lifecycle.ts'
import { prepareMicrosandbox, loadMicrosandbox, type PreparedRuntime } from '../src/microsandbox-runtime.ts'
import { visitorReadTool } from '../src/visitor-read.ts'
import { removeOwned } from '../src/sandbox-files.ts'
import { compose } from '../example/compose.ts'
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ipc } from './ipc.ts'

describe.skipIf(process.env['A2A_MICROSANDBOX_TEST'] !== '1')('real Microsandbox visitor boundary and persistence', () => {
  let base: string, runtime: PreparedRuntime, isolation: Awaited<ReturnType<typeof prepareIsolation>>
  let manager: VisitorSandboxes<MicrosandboxVM>, time = 0
  const signal = () => new AbortController().signal
  const context = () => ({ signal: signal() } as ToolRunContext)
  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'a2a-msb-integration-')))
    const publicRoot = join(base, 'public'), privateRoot = join(base, 'private')
    await mkdir(publicRoot); await mkdir(join(base, 'backend'))
    await writeFile(join(publicRoot, 'info.txt'), 'PUBLIC\n公开资料')
    await writeFile(join(base, 'backend/chat.txt'), 'BACKEND_SECRET')
    // Reproduce an old build's dependency junction without importing its target into the VM.
    await mkdir(join(publicRoot, 'build'))
    await symlink(join(base, 'backend'), join(publicRoot, 'build/node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    const config = Config({ peers: { alice: { tokenEnv: 'ALICE' }, bob: { tokenEnv: 'BOB' } }, isolation: {
      workspaceRoot: publicRoot, privateRoot, execution: 'microsandbox', peerWorkspaces: {} } } as unknown as A2AServerConfig)
    isolation = await prepareIsolation(config, join(base, 'backend'))
    for (const peer of ['alice','bob']) { await mkdir(isolation.workspaceFor(peer)); await writeFile(join(isolation.workspaceFor(peer), 'seed.txt'), peer) }
    runtime = await prepareMicrosandbox({ directory: process.env['A2A_MSB_TEST_RUNTIME'] || join(base, 'runtime'), onProgress: p => console.log(p.message) })
    manager = new VisitorSandboxes(await MicrosandboxDriver.create(isolation, { prepared: runtime }), { autoTick: false, now: () => time })
  }, 600_000)
  afterAll(async () => {
    await manager?.close()
    if (runtime) {
      const sdk = await loadMicrosandbox(runtime)
      for (const peer of ['alice','bob']) {
        try {
          const record = JSON.parse(await readFile(join(base,'private/.microsandbox',peer,'record.json'),'utf8')) as {name:string}
          await (await sdk.Sandbox.get(record.name)).destroy({ force: true })
        } catch (error) { if (!/ENOENT|not found|does not exist|not exist/i.test(String(error))) throw error }
      }
    }
    if (base) await removeOwned(await realpath(tmpdir()), base)
  }, 60_000)
  const reader = async (peer: string) => microsandboxReadTool(await visitorReadTool(isolation.dataRootFor(peer), isolation.workspaceFor(peer), isolation.privateDirectoriesFor(peer)), peer, manager)

  it('runs the actual read_file worker, imports old private files, separates peers, and enforces Python writes inside the private disk only', async () => {
    for (const peer of ['alice','bob']) {
      const tool = await reader(peer)
      expect(await tool.execute({path:'info.txt'},context())).toMatchObject({content:'PUBLIC\n公开资料'})
      expect(await tool.execute({root:'workspace',path:'seed.txt'},context())).toMatchObject({content:peer})
      await manager.run(peer, async vm => {
        const output = await vm.python(`import pathlib,os,json,socket
assert os.getuid()==1000
p=pathlib.Path('/source/info.txt')
denied=0
for fn in [lambda:p.write_text('BAD'),lambda:p.open('a'),lambda:p.unlink(),lambda:p.rename('/source/moved.txt'),lambda:pathlib.Path('/source/new.txt').write_text('BAD')]:
 try: fn()
 except OSError: denied+=1
assert denied==5,denied
assert not pathlib.Path('/work/../${peer==='alice'?'bob':'alice'}/seed.txt').exists()
assert not pathlib.Path('/backend/chat.txt').exists()
assert not pathlib.Path('/source/build/node_modules').exists()
assert not pathlib.Path('/var/run/docker.sock').exists()
assert not os.getenv('A2A_MSB_HOST_CANARY')
p=pathlib.Path('/work/created.txt');p.write_text('first');p.write_text('updated');p=p.rename('/work/renamed.txt');p.unlink()
pathlib.Path('/work/persist.txt').write_text('${peer} retained')
with socket.socket() as s:
 s.settimeout(1)
 try:s.connect(('1.1.1.1',443));raise AssertionError('network allowed')
 except OSError:pass
print(json.dumps({'privateCrud':True,'publicMutationsDenied':denied}))`, [], signal())
        expect(JSON.parse(output)).toMatchObject({privateCrud:true,publicMutationsDenied:5})
      }, signal())
      expect(await tool.execute({root:'workspace',path:'persist.txt'},context())).toMatchObject({content:`${peer} retained`})
      for (const path of ['../bob/seed.txt','/backend/chat.txt','C:\\Users\\someone\\secret.txt']) await expect(tool.execute({path},context())).rejects.toThrow()
    }
    expect(await readFile(join(base,'public/info.txt'),'utf8')).toBe('PUBLIC\n公开资料')
    expect(await readFile(join(base,'backend/chat.txt'),'utf8')).toBe('BACKEND_SECRET')
    expect(manager.snapshot().map(s=>s.peer).sort()).toEqual(['alice','bob'])
  }, 120_000)

  it('pauses at 30s, resumes, stops at 10min, and preserves files through manager restart', async () => {
    time+=30_000; await manager.tick()
    expect(manager.snapshot().every(s=>s.state==='paused')).toBe(true)
    expect(await (await reader('alice')).execute({root:'workspace',path:'persist.txt'},context())).toMatchObject({content:'alice retained'})
    expect(manager.snapshot().find(s=>s.peer==='alice')!.state).toBe('running')
    time+=600_000; await manager.tick()
    expect(manager.snapshot().every(s=>s.state==='stopped')).toBe(true)
    await manager.close()
    manager = new VisitorSandboxes(await MicrosandboxDriver.create(isolation,{prepared:runtime}),{autoTick:false,now:()=>time})
    for (const peer of ['alice','bob']) expect(await (await reader(peer)).execute({root:'workspace',path:'persist.txt'},context())).toMatchObject({content:`${peer} retained`})
  },60_000)

  it('refreshes changed public data while preserving the visitor disk', async () => {
    await writeFile(join(base,'public/info.txt'),'UPDATED_PUBLIC')
    expect(await (await reader('alice')).execute({path:'info.txt'},context())).toMatchObject({content:'UPDATED_PUBLIC'})
    expect(await (await reader('alice')).execute({root:'workspace',path:'persist.txt'},context())).toMatchObject({content:'alice retained'})
  },60_000)

  it('rejects host hardlinks and junctions before exposure, including after an existing VM was started', async () => {
    const alias = join(base,'public/alias.txt')
    await link(join(base,'backend/chat.txt'),alias)
    await expect((await reader('alice')).execute({path:'alias.txt'},context())).rejects.toThrow('Links')
    await rm(alias)
    const junction=join(base,'public/junction')
    await symlink(join(base,'backend'),junction,process.platform==='win32'?'junction':'dir')
    await expect((await reader('alice')).execute({path:'junction/chat.txt'},context())).rejects.toThrow('Links')
    await rm(junction)
    expect(await readFile(join(base,'backend/chat.txt'),'utf8')).toBe('BACKEND_SECRET')
  })

  it('cancels a running Python tool without leaving it active, then accepts another tool', async () => {
    const controller=new AbortController()
    const work=manager.run('alice',vm=>vm.python('import time; time.sleep(30)',[],controller.signal),controller.signal)
    const timer=setTimeout(()=>controller.abort(),1000)
    try{await expect(work).rejects.toThrow()}finally{clearTimeout(timer)}
    expect(manager.snapshot().find(s=>s.peer==='alice')!.active).toBe(0)
    expect(await (await reader('alice')).execute({root:'workspace',path:'persist.txt'},context())).toMatchObject({content:'alice retained'})
  },60_000)

  it('recovers an abandoned live VM after host ownership is released, preserving its disk', async () => {
    await manager.close()
    const abandoned = await MicrosandboxDriver.create(isolation, { prepared: runtime })
    const vm = await abandoned.start('alice')
    await vm.python("from pathlib import Path; Path('/work/recovered.txt').write_text('survived host restart')", [], signal())
    await vm.pause()
    await abandoned.close() // Simulate a lost controller; deliberately do not stop the VM.
    manager = new VisitorSandboxes(await MicrosandboxDriver.create(isolation, { prepared: runtime }), { autoTick: false, now: () => time })
    const sdk = await loadMicrosandbox(runtime)
    const record = JSON.parse(await readFile(join(base,'private/.microsandbox/alice/record.json'),'utf8')) as {name:string}
    expect((await sdk.Sandbox.get(record.name)).status).toBe('stopped')
    expect(await (await reader('alice')).execute({root:'workspace',path:'recovered.txt'},context())).toMatchObject({content:'survived host restart'})
  },60_000)

  it('runs real DSH tool dispatch over authenticated A2A with the Microsandbox backend', async () => {
    await manager.close()
    const oldHome = process.env['A2A_SANDBOX_HOME'], oldToken = process.env['A2A_MSB_TEST_PEER']
    process.env['A2A_SANDBOX_HOME'] = runtime.directory
    process.env['A2A_MSB_TEST_PEER'] = 'synthetic-a2a-microsandbox-test-token'
    let app: Awaited<ReturnType<typeof compose>> | undefined
    try {
      app = await compose({ forceStub: true, workspaceRoot: join(base,'public'), peers: { alice: 'A2A_MSB_TEST_PEER' }, overrides: {
        isolation: { workspaceRoot: join(base,'public'), privateRoot: join(base,'private'), workspaceMode: 'per-peer', peerWorkspaces: {}, execution: 'microsandbox' },
      } })
      let calls = 0
      app.adapter.stream = async function* (options): AsyncIterable<StreamChunk> {
        if (++calls === 1) {
          const id = ToolCallId('native-sandbox-read'), args = '{"root":"workspace","path":"persist.txt"}'
          yield { type:'block-start', index:0, blockType:'tool-call' }
          yield { type:'tool-call-delta', index:0, id, name:'read_file', argumentsDelta:args }
          yield { type:'block-end', index:0, block:{type:'tool-call',id,name:'read_file',arguments:args} }
          yield { type:'finish',reason:{kind:'tool-calls'} }
        } else {
          expect(JSON.stringify(options.messages)).toContain('alice retained')
          yield {type:'block-start',index:0,blockType:'text'}
          yield {type:'text-delta',index:0,text:'Verified persistent private file through VM'}
          yield {type:'block-end',index:0,block:{type:'text',text:'Verified persistent private file through VM'}}
          yield {type:'finish',reason:{kind:'stop'}}
        }
      }
      const response = await fetch(app.rpcUrl, {method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${process.env['A2A_MSB_TEST_PEER']}`},body:JSON.stringify({
        jsonrpc:'2.0',id:1,method:'SendMessage',params:{message:{messageId:'sandbox-integration',role:'ROLE_USER',parts:[{text:'Read my private file'}]}},
      })})
      expect(response.status).toBe(200)
      const body = await response.json() as {result:{task:{contextId:string,status:{state:string},artifacts:unknown}}}
      expect(body.result.task.status.state).toBe('TASK_STATE_COMPLETED')
      expect(JSON.stringify(body.result.task.artifacts)).toContain('Verified persistent private file')
      expect(calls).toBe(2)
      const agent = app.ctx.agents.list().find(a=>a.session.id===body.result.task.contextId)!
      expect(app.ctx.tools.schemas(agent).map(t=>t.name)).toEqual(['read_file'])
    } finally {
      await app?.stop()
      if (oldHome === undefined) delete process.env['A2A_SANDBOX_HOME']; else process.env['A2A_SANDBOX_HOME'] = oldHome
      if (oldToken === undefined) delete process.env['A2A_MSB_TEST_PEER']; else process.env['A2A_MSB_TEST_PEER'] = oldToken
    }
  },60_000)

  it.each(['public', 'invited'] as const)('creates separate real VMs for dynamically admitted %s visitors and denies cross-workspace reads', async (admission) => {
    await manager.close()
    await writeFile(join(base, 'public/info.txt'), 'PUBLIC\n公开资料')
    const oldHome = process.env['A2A_SANDBOX_HOME'], oldOwner = process.env['A2A_MSB_LIVE_OWNER'], privateRoot = join(base, `${admission}-visitor-workspaces`)
    process.env['A2A_SANDBOX_HOME'] = runtime.directory
    process.env['A2A_MSB_LIVE_OWNER'] = 'fixture-msb-local-owner-token'
    let app: Awaited<ReturnType<typeof compose>> | undefined
    const visitors: { token: string; visitorId: string }[] = []
    try {
      app = await compose({ forceStub: true, workspaceRoot: join(base, 'public'), peers: {}, adminTokenEnv: 'A2A_MSB_LIVE_OWNER', overrides: {
        publicVisitors: { enabled: true },
        isolation: { workspaceRoot: join(base, 'public'), privateRoot, workspaceMode: 'per-peer', peerWorkspaces: {}, execution: 'microsandbox' },
      } })
      const rpc = async (method: string, token?: string, params: unknown = {}) => {
        const response = await fetch(app!.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
        expect(response.status).toBe(200)
        return await response.json() as any
      }
      for (let i = 0; i < 2; i++) {
        const visitor = admission === 'public' ? (await rpc('talk2myagent/RegisterPublicVisitor')).result
          : { visitorId: `visitor-${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`, token: `fixture-msb-invited-${i}-token` }
        if (admission === 'invited') expect((await ipc(app.managementSocket, '/a2a/admin/visitors', process.env['A2A_MSB_LIVE_OWNER'], 'POST',
          { name: visitor.visitorId, token: visitor.token, trusted: true })).body.applied).toBe(true)
        visitors.push(visitor)
        await mkdir(join(privateRoot, visitor.visitorId))
        await writeFile(join(privateRoot, visitor.visitorId, 'seed.txt'), `PRIVATE_MARKER_${i}`)
      }
      const names: string[] = []
      for (const [i, visitor] of visitors.entries()) {
        let calls = 0
        const reads = [{ path: 'info.txt' }, { root: 'workspace', path: 'seed.txt' },
          { root: 'workspace', path: `../${visitors[1 - i]!.visitorId}/seed.txt` }]
        app.adapter.stream = async function* (options): AsyncIterable<StreamChunk> {
          const args = reads[calls++]
          if (args) {
            const id = ToolCallId(`public-read-${calls}`), json = JSON.stringify(args)
            yield { type: 'block-start', index: 0, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index: 0, id, name: 'read_file', argumentsDelta: json }
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'read_file', arguments: json } }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
          } else {
            const transcript = JSON.stringify(options.messages)
            expect(transcript).toContain('公开资料')
            expect(transcript).toContain(`PRIVATE_MARKER_${i}`)
            expect(transcript).not.toContain(`PRIVATE_MARKER_${1 - i}`)
            expect(transcript).not.toContain('BACKEND_SECRET')
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'text-delta', index: 0, text: 'public visitor VM verified' }
            yield { type: 'block-end', index: 0, block: { type: 'text', text: 'public visitor VM verified' } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          }
        }
        const reply = await rpc('SendMessage', visitor.token, { message: { messageId: `public-vm-${i}`, role: 'ROLE_USER', parts: [{ text: 'Read files' }] } })
        expect(reply.result.task.status.state).toBe('TASK_STATE_COMPLETED')
        expect(JSON.stringify(reply.result.task.artifacts)).toContain('public visitor VM verified')
        expect(calls).toBe(4)
        if (admission === 'public') expect((await rpc('talk2myagent/GetPublicVisitorStatus', visitor.token)).result.remainingTurns).toBe(4)
        names.push(JSON.parse(await readFile(join(privateRoot, '.microsandbox', visitor.visitorId, 'record.json'), 'utf8')).name)
      }
      expect(new Set(names).size).toBe(2)
      expect(await readFile(join(base, 'public/info.txt'), 'utf8')).toBe('PUBLIC\n公开资料')
    } finally {
      await app?.stop()
      const sdk = await loadMicrosandbox(runtime)
      for (const visitor of visitors) {
        try {
          const record = JSON.parse(await readFile(join(privateRoot, '.microsandbox', visitor.visitorId, 'record.json'), 'utf8'))
          await (await sdk.Sandbox.get(record.name)).destroy({ force: true })
        } catch (error) { if (!/ENOENT|not found|does not exist|not exist/i.test(String(error))) throw error }
      }
      if (oldHome === undefined) delete process.env['A2A_SANDBOX_HOME']; else process.env['A2A_SANDBOX_HOME'] = oldHome
      if (oldOwner === undefined) delete process.env['A2A_MSB_LIVE_OWNER']; else process.env['A2A_MSB_LIVE_OWNER'] = oldOwner
    }
  }, 90_000)

  it.skipIf(process.env['A2A_MSB_WALLCLOCK'] !== '1')('uses the real idle timer: 30 seconds pause, 10 minutes stop, files retained', async () => {
    await manager.close()
    manager = new VisitorSandboxes(await MicrosandboxDriver.create(isolation, { prepared: runtime }))
    await (await reader('alice')).execute({root:'workspace',path:'persist.txt'},context())
    const started = Date.now(), sdk = await loadMicrosandbox(runtime)
    const record = JSON.parse(await readFile(join(base,'private/.microsandbox/alice/record.json'),'utf8')) as {name:string}
    const until = async (state: string, deadline: number) => {
      while (manager.snapshot()[0]!.state !== state && Date.now() < deadline) await new Promise(r=>setTimeout(r,500))
      expect(manager.snapshot()[0]!.state).toBe(state)
      expect((await sdk.Sandbox.get(record.name)).status).toBe(state)
      console.log(`Real idle ${state} at ${Date.now()-started} ms`)
    }
    await until('paused',started+35_000)
    expect(Date.now()-started).toBeGreaterThanOrEqual(30_000)
    await until('stopped',started+610_000)
    expect(Date.now()-started).toBeGreaterThanOrEqual(600_000)
    expect(await (await reader('alice')).execute({root:'workspace',path:'persist.txt'},context())).toMatchObject({content:'alice retained'})
  },630_000)
})
