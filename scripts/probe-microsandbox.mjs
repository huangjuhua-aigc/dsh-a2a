// Opt-in Windows experiment. Does not install dependencies or change the production executor.
// npm install --prefix <isolated-lab> --save-exact microsandbox@0.7.11
// pnpm build (required for the existing application mount preflight below)
// node scripts/probe-microsandbox.mjs <isolated-lab>
import { mkdir, mkdtemp, readFile, writeFile, readdir, lstat, link, symlink, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir, platform, release, arch } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyMountTree } from '../lib/isolation.js';

const lab = await realpath(path.resolve(process.argv[2] || ''));
const tempRelative = path.relative(await realpath(tmpdir()), lab);
if (!process.argv[2] || !tempRelative || path.isAbsolute(tempRelative) || tempRelative === '..' || tempRelative.startsWith('..' + path.sep)) {
  throw new Error('Pass an isolated lab directory under the system temp directory');
}
process.env.MSB_HOME = path.join(lab, 'runtime');
process.env.A2A_MSB_HOST_CANARY = randomUUID();
const sdkPath = path.join(lab, 'node_modules/microsandbox');
const { Sandbox, MiB } = await import(pathToFileURL(path.join(sdkPath, 'dist/index.js')));
const sdkVersion = JSON.parse(await readFile(path.join(sdkPath, 'package.json'), 'utf8')).version;
const base = await mkdtemp(path.join(lab, 'run-'));
const source = path.join(base, 'public');
const alice = path.join(base, 'private/alice');
const bob = path.join(base, 'private/bob');
const backend = path.join(base, 'backend');
const outside = path.join(base, 'outside');
const exportsRoot = path.join(base, 'exports');
const python = await readFile(new URL('./probe-microsandbox.py', import.meta.url), 'utf8');
const image = 'docker.io/library/python:3.12-slim';
const result = { startedAt: new Date().toISOString(), sdkVersion,
  environment: { platform: platform(), release: release(), arch: arch(), node: process.version },
  lab: base, image, policy: { cpu: 1, memoryMiB: 512, security: 'restricted', network: false, guestUser: 'root (stronger mount enforcement probe)' },
  checks: [], performance: {}, observations: [], errors: [], cleanup: [] };
const live = new Map();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const rounded = n => Math.round(n * 100) / 100;
const record = (name, passed, extra = {}) => { result.checks.push({ ...extra, name, passed }); };
const checkpoint = () => writeFile(path.join(base, 'results.json'), JSON.stringify(result, null, 2));
const log = message => console.log(new Date().toISOString(), message);
function stats(values) {
  const sorted = [...values].sort((a,b) => a-b);
  return { count: values.length, minMs: rounded(sorted[0]), medianMs: rounded((sorted[Math.floor((sorted.length - 1)/2)] + sorted[Math.floor(sorted.length/2)])/2),
    maxMs: rounded(sorted.at(-1)), samplesMs: values.map(rounded) };
}
async function snapshot(root) {
  const data = {};
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name), key = path.relative(root, full);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) data[key] = 'LINK';
      else if (stat.isDirectory()) { data[key] = 'DIRECTORY'; await visit(full); }
      else data[key] = sha(await readFile(full));
    }
  }
  await visit(root);
  return JSON.stringify(Object.fromEntries(Object.entries(data).sort(([a],[b]) => a.localeCompare(b))));
}
async function makeSandbox(label, own = alice, customMounts) {
  const name = `a2a-msb-${label}-${randomUUID().slice(0, 8)}`;
  let builder = Sandbox.builder(name).image(image).pullPolicy('never')
    .cpus(1).memory(MiB(512)).security('restricted').disableNetwork().maxDuration(600);
  if (customMounts) builder = customMounts(builder);
  else builder = builder.volume('/public', m => m.bind(source).readonly().noexec().nosuid().nodev())
    .volume('/work', m => m.bind(own).nosuid().nodev().quota(64));
  const started = performance.now();
  const sb = await builder.create();
  const elapsed = performance.now() - started;
  live.set(name, sb);
  if (sb.backendKind !== 'local') throw new Error('Unexpected non-local backend');
  return { sb, elapsed };
}
async function destroy(sb) {
  try { await sb.destroy(); live.delete(sb.name); result.cleanup.push({ name: sb.name, removed: true }); }
  catch (error) { result.cleanup.push({ name: sb.name, removed: false, error: String(error) }); throw error; }
}
async function execPython(sb, code, args = []) {
  const out = await sb.execWith('python3', b => b.args(['-c', code, ...args]).timeout(30000));
  if (out.code !== 0) throw new Error(`Guest Python exit ${out.code}: ${out.stderr()}`);
  return out.stdout();
}
try {
  for (const dir of [source, path.join(source, 'empty-dir'), alice, bob, backend, outside, exportsRoot]) await mkdir(dir, { recursive: true });
  for (const name of ['read', 'overwrite', 'append', 'delete', 'rename', 'move', 'truncate', 'chmod']) await writeFile(path.join(source, name + '.txt'), 'PUBLIC_FIXTURE');
  await writeFile(path.join(alice, 'secret.txt'), 'ALICE_ONLY');
  await writeFile(path.join(bob, 'secret.txt'), 'BOB_ONLY');
  await writeFile(path.join(backend, 'chat.txt'), 'BACKEND_NOT_MOUNTED');
  await writeFile(path.join(outside, 'guard.txt'), 'OUTSIDE_NOT_MOUNTED');
  const protectedRoots = [source, backend, outside];
  const before = await Promise.all(protectedRoots.map(snapshot));
  for (const [peer, ownRoot, own, otherRoot, otherPeer] of [
    ['alice', alice, 'ALICE_ONLY', bob, 'bob'], ['bob', bob, 'BOB_ONLY', alice, 'alice']]) {
    log(`Isolation and export: ${peer}`);
    const otherBefore = await snapshot(otherRoot);
    const { sb, elapsed } = await makeSandbox(peer, ownRoot);
    result.observations.push({ name: `${peer}_create_ms`, value: rounded(elapsed) });
    try {
      const data = JSON.parse(await execPython(sb, python, [JSON.stringify({ own, otherPeer,
        hostPaths: [path.join(otherRoot, 'secret.txt'), path.join(backend, 'chat.txt'), path.join(outside, 'guard.txt')] })]));
      result.observations.push({ name: `${peer}_guest_uid`, value: data.uid });
      for (const check of data.checks) record(`${peer}.${check.name}`, check.passed, check);
      record(`${peer}.other_workspace_unchanged`, otherBefore === await snapshot(otherRoot));
      const hostBytes = await readFile(path.join(ownRoot, 'generated.bin'));
      const returnedBytes = await sb.fs().read('/work/generated.bin');
      record(`${peer}.sdk_returns_generated_bytes`, sha(hostBytes) === sha(returnedBytes));
      const exportPath = path.join(exportsRoot, peer + '-generated.bin');
      await sb.fs().copyToHost('/work/generated.bin', exportPath);
      record(`${peer}.host_export_hash_matches`, sha(hostBytes) === sha(await readFile(exportPath)), { sha256: sha(hostBytes), bytes: hostBytes.length });
      if (peer === 'alice') {
        const samples = [];
        for (let i=0; i<20; i++) { const t=performance.now(); await execPython(sb, 'from pathlib import Path; assert Path("/public/read.txt").read_text() == "PUBLIC_FIXTURE"; print("ok")'); samples.push(performance.now()-t); }
        result.performance.execPythonRead = stats(samples);
        result.observations.push({ name: 'running_metrics', value: await sb.metrics() });
        const resumes = [], resumeReads = [], pauses = [];
        try {
          for (let i=0; i<10; i++) {
            let t=performance.now(); await sb.pause(); pauses.push(performance.now()-t);
            t=performance.now(); await sb.resume(); resumes.push(performance.now()-t);
            await execPython(sb, 'from pathlib import Path; assert Path("/public/read.txt").read_text() == "PUBLIC_FIXTURE"; print("ok")');
            resumeReads.push(performance.now()-t);
          }
          result.performance.pauseResident = stats(pauses); result.performance.resumeResident = stats(resumes); result.performance.resumeAndPythonRead = stats(resumeReads);
        } catch(error) { result.observations.push({ name: 'pause_resume_unavailable', error: String(error) }); await sb.resume().catch(()=>{}); }
      }
    } finally { await destroy(sb); }
    record(`${peer}.file_persists_after_vm_destroy`, (await readFile(path.join(ownRoot, 'generated.bin'))).length > 256);
    const { sb: fresh } = await makeSandbox(peer + '-restart', ownRoot);
    try { record(`${peer}.new_vm_reads_persisted_output`, (await fresh.fs().read('/work/generated.bin')).length > 256); }
    finally { await destroy(fresh); }
    await checkpoint();
  }
  for (let i=0; i<protectedRoots.length; i++) record(`host.${path.basename(protectedRoots[i])}_tree_unchanged`, before[i] === await snapshot(protectedRoots[i]));

  log('Cached-image fresh VM creation benchmark, 10 samples');
  const create = [], ready = [], disposal = [];
  for (let i=0; i<10; i++) {
    const {sb, elapsed} = await makeSandbox('bench'); create.push(elapsed);
    try { const t=performance.now(); await execPython(sb, 'from pathlib import Path; assert Path("/public/read.txt").read_text() == "PUBLIC_FIXTURE"; print("ok")'); ready.push(elapsed+performance.now()-t); }
    finally { const t=performance.now(); await destroy(sb); disposal.push(performance.now()-t); }
  }
  result.performance.cachedCreate = stats(create); result.performance.cachedCreateAndPythonRead = stats(ready); result.performance.destroy = stats(disposal);
  await checkpoint();

  // Separate adversarial fixtures: never link real user data. Report runtime behavior,
  // not an expected PASS when a pre-existing host alias exposes an outside inode.
  log('Pre-existing host junction / hardlink boundary probes');
  const aliases = path.join(base, 'adversarial-mount');
  const aliasOutside = path.join(base, 'adversarial-outside');
  await mkdir(aliases); await mkdir(aliasOutside);
  await writeFile(path.join(aliasOutside, 'hardlink-target.txt'), 'HARDLINK_CANARY');
  await writeFile(path.join(aliasOutside, 'junction-target.txt'), 'JUNCTION_CANARY');
  await link(path.join(aliasOutside, 'hardlink-target.txt'), path.join(aliases, 'hardlink.txt'));
  await symlink(aliasOutside, path.join(aliases, 'junction'), 'junction');
  const hardlinkOnly = path.join(base, 'hardlink-preflight');
  const junctionOnly = path.join(base, 'junction-preflight');
  await mkdir(hardlinkOnly); await mkdir(junctionOnly);
  await link(path.join(aliasOutside, 'hardlink-target.txt'), path.join(hardlinkOnly, 'alias.txt'));
  await symlink(aliasOutside, path.join(junctionOnly, 'junction'), 'junction');
  for (const [name, root] of [['hardlink', hardlinkOnly], ['junction', junctionOnly]]) {
    try { await verifyMountTree(root); record(`app_preflight.reject_${name}`, false); }
    catch (error) { record(`app_preflight.reject_${name}`, true, { error: String(error) }); }
  }
  const aliasBefore = await snapshot(aliasOutside);
  const { sb: aliasVm } = await makeSandbox('aliases', alice, builder => builder.volume('/aliases', m => m.bind(aliases).nosuid().nodev()));
  try {
    const output = await execPython(aliasVm, `import json,pathlib\nresults=[]\nfor name in ['hardlink.txt','junction/junction-target.txt']:\n p=pathlib.Path('/aliases')/name\n r={'path':name}\n try: r['read']=p.read_text()\n except OSError as e: r['readError']=str(e)\n try: p.write_text('ALIAS_PROBE_CHANGED_SYNTHETIC_CANARY');r['writeSucceeded']=True\n except OSError as e: r['writeError']=str(e)\n results.append(r)\nprint(json.dumps(results))`);
    result.observations.push({ name: 'raw_host_alias_behavior', value: JSON.parse(output) });
  } finally { await destroy(aliasVm); }
  result.observations.push({ name: 'raw_host_alias_outside_unchanged', value: aliasBefore === await snapshot(aliasOutside) });
  result.rawBindSafeWithoutPreflight = aliasBefore === await snapshot(aliasOutside);
  if (!result.rawBindSafeWithoutPreflight) result.observations.push({ name: 'blocking_integration_requirement', value: 'Reject pre-existing host hardlinks/reparse points before any bind, guard against host-side changes while mounted, or use private VM disks and controlled file export. Raw writable host bind does not meet strict path-only protection.' });
} catch (error) {
  result.errors.push({ message: String(error), stack: error.stack }); process.exitCode = 1; log(String(error));
} finally {
  for (const sb of live.values()) await destroy(sb).catch(error => result.errors.push({ cleanupError: String(error) }));
  result.finishedAt = new Date().toISOString();
  result.summary = { passed: result.checks.filter(c=>c.passed).length, failed: result.checks.filter(c=>!c.passed).length, errors: result.errors.length };
  if (result.summary.failed || result.summary.errors) process.exitCode = 1;
  await checkpoint();
  console.log(JSON.stringify({ resultFile: path.join(base,'results.json'), summary: result.summary, performance: result.performance, errors: result.errors }, null, 2));
}
