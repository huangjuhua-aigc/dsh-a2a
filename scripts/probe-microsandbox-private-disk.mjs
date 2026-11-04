// Alternative: private virtual disk instead of a writable Windows directory bind.
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
const lab=await realpath(process.argv[2]), run=await realpath(process.argv[3]);
for(const root of [lab,run]) {const r=path.relative(await realpath(tmpdir()),root);if(!r || path.isAbsolute(r) || r.startsWith('..'))throw new Error('Only temp fixtures allowed');}
process.env.MSB_HOME=path.join(lab,'runtime');
const {Sandbox,MiB}=await import(pathToFileURL(path.join(lab,'node_modules/microsandbox/dist/index.js')));
const name='a2a-msb-private-disk-'+randomUUID().slice(0,8);
const result={startedAt:new Date().toISOString(),name,checks:[],errors:[],policy:{public:'read-only host bind',private:'owned 128 MiB disk; no writable host directory bind'}};
const hash=data=>createHash('sha256').update(data).digest('hex');
const record=(name,passed)=>result.checks.push({name,passed});
let sb;
try {
  const t=performance.now();
  sb=await Sandbox.builder(name).image('docker.io/library/python:3.12-slim').pullPolicy('never')
    .cpus(1).memory(MiB(512)).security('restricted').disableNetwork().maxDuration(180)
    .volume('/public',m=>m.bind(path.join(run,'public')).readonly().noexec().nosuid().nodev())
    .volume('/work',m=>m.owned({kind:'disk',sizeMib:128}).nosuid().nodev()).create();
  result.createMs=performance.now()-t;
  const program=`from pathlib import Path
import os,json
checks=[]
def denied(name,fn):
 try: fn(); checks.append({'name':name,'passed':False})
 except OSError: checks.append({'name':name,'passed':True})
p=Path('/public/overwrite.txt')
assert p.read_text()=='PUBLIC_FIXTURE'
denied('public_write_denied',lambda:p.write_text('bad'))
denied('public_delete_denied',lambda:p.unlink())
denied('public_to_private_hardlink_denied',lambda:os.link(p,'/work/alias.txt'))
f=Path('/work/remove-me.txt');f.write_text('1');f.write_text('2');f=f.rename('/work/renamed.txt');f.unlink()
checks.append({'name':'private_crud','passed':not f.exists()})
Path('/work/report.txt').write_text('Persistent private disk output\\n生成成功\\n')
checks.append({'name':'other_workspace_absent','passed':not Path('/private/bob/secret.txt').exists()})
print(json.dumps(checks))`;
  const out=await sb.exec('python3',['-c',program]);
  if(out.code!==0)throw new Error(out.stderr());
  result.checks.push(...JSON.parse(out.stdout()));
  const bytes=await sb.fs().read('/work/report.txt');
  const exported=path.join(run,'exports/private-disk-report.txt');
  await sb.fs().copyToHost('/work/report.txt',exported);
  record('export_bytes_equal',hash(bytes)===hash(await readFile(exported)));
  const stopStart=performance.now();
  await sb.stopWithTimeout(10000);
  sb=await Sandbox.start(name);
  result.stopAndStartMs=performance.now()-stopStart;
  record('private_disk_survives_stop_start',hash(bytes)===hash(await sb.fs().read('/work/report.txt')));
  await sb.destroy();sb=null;
  record('export_survives_vm_destroy',hash(bytes)===hash(await readFile(exported)));
  result.exportedFile=exported;
} catch(error){result.errors.push({message:String(error),stack:error.stack});process.exitCode=1;}
finally {
  if(sb)await sb.destroy().catch(e=>result.errors.push({cleanup:String(e)}));
  result.finishedAt=new Date().toISOString();result.passed=result.errors.length===0 && result.checks.every(c=>c.passed);
  if(!result.passed)process.exitCode=1;
  await writeFile(path.join(run,'private-disk.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
