// Opt-in resident-pause versus stop experiment; synthetic files only.
// node scripts/probe-microsandbox-resources.mjs <existing temp lab>
import { mkdir, mkdtemp, readFile, writeFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const lab=await realpath(process.argv[2]);
const rel=path.relative(await realpath(tmpdir()),lab);
if(!rel || path.isAbsolute(rel) || rel==='..' || rel.startsWith('..'+path.sep))throw new Error('Only temp labs allowed');
process.env.MSB_HOME=path.join(lab,'runtime');
const {Sandbox,MiB}=await import(pathToFileURL(path.join(lab,'node_modules/microsandbox/dist/index.js')));
const run=await mkdtemp(path.join(lab,'resources-'));
const work=path.join(run,'work');await mkdir(work);
const name='a2a-msb-resources-'+randomUUID().slice(0,8);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const execFileAsync=promisify(execFile);
const result={startedAt:new Date().toISOString(),name,hostControllerPid:process.pid,settings:{cpus:1,memoryMiB:512,extraLivePythonMemoryMiB:128},stages:[],timings:{},checks:[],errors:[]};
let sb;
async function hostProcesses(){
  const command=`$all = @(Get-CimInstance Win32_Process)
$ids = [System.Collections.Generic.HashSet[int]]::new()
$null = $ids.Add(${process.pid})
do { $changed=$false; foreach($p in $all) { if($ids.Contains([int]$p.ParentProcessId) -and ($p.Name -eq 'msb.exe' -or $p.Name -eq 'node.exe') -and $ids.Add([int]$p.ProcessId)) { $changed=$true } } } while($changed)
$rows = @(foreach($processId in $ids) { $p=Get-Process -Id $processId -ErrorAction SilentlyContinue; if($p) { [pscustomobject]@{pid=$p.Id;name=$p.ProcessName;workingSetBytes=$p.WorkingSet64;privateBytes=$p.PrivateMemorySize64;cpuSeconds=$p.TotalProcessorTime.TotalSeconds} } })
ConvertTo-Json -InputObject $rows -Compress`;
  const {stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,maxBuffer:1024*1024});
  return JSON.parse(stdout);
}
async function sample(label){
  console.log(label);
  const t=performance.now();const first=await hostProcesses();await sleep(2000);const second=await hostProcesses();
  const seconds=(performance.now()-t)/1000;
  const cpuDelta=second.reduce((sum,p)=>sum+p.cpuSeconds-(first.find(q=>q.pid===p.pid)?.cpuSeconds??p.cpuSeconds),0);
  const vmCpuDelta=second.filter(p=>p.name==='msb').reduce((sum,p)=>sum+p.cpuSeconds-(first.find(q=>q.pid===p.pid)?.cpuSeconds??p.cpuSeconds),0);
  const item={label,at:new Date().toISOString(),firstProcesses:first,processes:second,workingSetBytes:second.reduce((s,p)=>s+p.workingSetBytes,0),privateBytes:second.reduce((s,p)=>s+p.privateBytes,0),sampleWallSeconds:seconds,cpuSecondsDelta:cpuDelta,percentOfOneCore:100*cpuDelta/seconds,vmPercentOfOneCore:100*vmCpuDelta/seconds,controllerRssBytes:process.memoryUsage().rss};
  if(sb){
    const handle=await Sandbox.get(name); item.status=handle.status;
    try{item.metrics=await handle.metrics();}catch(error){item.metricsError=String(error);}
    try{item.storage=await handle.storageUsage(); item.sandboxDisk=await diskAllocation(item.storage.path);}catch(error){item.storageError=String(error);}
  }
  result.stages.push(item);
}
async function diskAllocation(root){
  const relative=path.relative(lab,root);if(!relative || path.isAbsolute(relative) || relative.startsWith('..'))throw new Error('Invalid runtime path');
  const command=`Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class A2ADiskSize {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern uint GetCompressedFileSizeW(string fileName, out uint high);
 public static ulong Allocated(string fileName) {
  uint high; uint low=GetCompressedFileSizeW(fileName,out high);
  if(low==uint.MaxValue && Marshal.GetLastWin32Error()!=0) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  return ((ulong)high<<32)+low;
 }
}
'@
$root='${root.replaceAll("'","''")}'
$files=@(Get-ChildItem -LiteralPath $root -File -Recurse -Force | ForEach-Object { [pscustomobject]@{name=$_.FullName.Substring($root.Length+1);logicalBytes=$_.Length;allocatedBytes=[A2ADiskSize]::Allocated($_.FullName)} })
ConvertTo-Json -InputObject $files -Compress`;
  const {stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,maxBuffer:1024*1024});
  const files=JSON.parse(stdout);
  return {logicalBytes:files.reduce((s,f)=>s+f.logicalBytes,0),allocatedBytes:files.reduce((s,f)=>s+f.allocatedBytes,0),files};
}
async function timed(key,fn){const t=performance.now();const value=await fn();result.timings[key]=performance.now()-t;return value;}
async function py(code){const out=await sb.execWith('python3',b=>b.args(['-c',code]).timeout(10000));if(out.code!==0)throw new Error(out.stderr());return out.stdout();}
async function readCounter(){return Number(await readFile(path.join(work,'counter.txt'),'utf8'));}
try {
  await sample('controller_only_before_vm');
  sb=await timed('createMs',()=>Sandbox.builder(name).image('docker.io/library/python:3.12-slim').pullPolicy('never')
    .cpus(1).memory(MiB(512)).security('restricted').disableNetwork().maxDuration(300)
    .volume('/work',m=>m.bind(work).nosuid().nodev()).create());
  await py('from pathlib import Path; Path("/work/persistent.txt").write_text("PERSISTENT_FIXTURE"); print("ready")');
  await sleep(1500);
  await sample('running_idle_light');
  await timed('pauseLightMs',()=>sb.pause());
  await sample('paused_light');
  await timed('resumeLightMs',()=>sb.resume());
  const job=await sb.execDetached('python3',['-u','-c',`import time,pathlib,os
payload=bytearray(128*1024*1024)
for i in range(0,len(payload),4096):payload[i]=1
pathlib.Path('/work/job-pid.txt').write_text(str(os.getpid()))
count=0
while True:
 count+=1
 temp=pathlib.Path('/work/counter.next');temp.write_text(str(count));temp.replace('/work/counter.txt')
 time.sleep(0.1)
`]);
  result.liveJobId=job.id;
  for(let i=0;i<100;i++){try{await readCounter();break;}catch{await sleep(100);}}
  await sample('running_with_128MiB_python');
  await timed('pauseLoadedMs',()=>sb.pause());
  const pausedCounter=await readCounter();
  await sample('paused_with_128MiB_python');
  result.checks.push({name:'guest_process_frozen_during_pause',passed:pausedCounter===await readCounter()});
  await timed('resumeLoadedMs',()=>sb.resume());
  await sleep(500);
  result.checks.push({name:'same_process_continues_after_resume',passed:(await readCounter())>pausedCounter && (await job.inspect()).state==='running'});
  await sample('resumed_with_128MiB_python');
  await timed('stopLoadedMs',()=>sb.stopWithTimeout(10000));
  await sample('stopped');
  const stoppedCounter=await readCounter();
  sb=await timed('startExistingMs',()=>Sandbox.start(name));
  await sleep(500);
  result.checks.push({name:'previous_python_not_restarted_by_start',passed:stoppedCounter===await readCounter()});
  result.checks.push({name:'disk_file_persists_after_stop_start',passed:(await py('from pathlib import Path; print(Path("/work/persistent.txt").read_text())')).trim()==='PERSISTENT_FIXTURE'});
  await sample('started_again_light');
  await sb.destroy();sb=null;
  await sample('controller_only_after_destroy');
} catch(error){result.errors.push({message:String(error),stack:error.stack});process.exitCode=1;}
finally {
  if(sb){await sb.resume().catch(()=>{});await sb.destroy().catch(error=>result.errors.push({cleanup:String(error)}));}
  result.finishedAt=new Date().toISOString();result.passed=result.errors.length===0 && result.checks.every(c=>c.passed);
  if(!result.passed)process.exitCode=1;
  await writeFile(path.join(run,'results.json'),JSON.stringify(result,(_,v)=>typeof v==='bigint'?v.toString():v,2));
  console.log(JSON.stringify({file:path.join(run,'results.json'),passed:result.passed,timings:result.timings,checks:result.checks,errors:result.errors,stages:result.stages.map(s=>({label:s.label,status:s.status,processes:s.processes,workingSetMiB:s.workingSetBytes/1048576,privateMiB:s.privateBytes/1048576,cpuPercentOneCore:s.percentOfOneCore,metricHostResidentMiB:s.metrics?.memoryHostResidentBytes/1048576,storage:s.storage}))},(_,v)=>typeof v==='bigint'?v.toString():v,2));
}
