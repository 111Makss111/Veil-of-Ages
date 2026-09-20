import { readFile } from 'node:fs/promises';

export const MEMORY_SOFT_RATIO=.75;
export const MEMORY_HARD_RATIO=.82;
const paths=[
  ['/sys/fs/cgroup/memory.current','/sys/fs/cgroup/memory.max','/sys/fs/cgroup/memory.stat'],
  ['/sys/fs/cgroup/memory/memory.usage_in_bytes','/sys/fs/cgroup/memory/memory.limit_in_bytes','/sys/fs/cgroup/memory/memory.stat']
] as const;

export type MemoryBudget={used:number;limit:number;ratio:number;level:'safe'|'waiting'|'pressure'};

export function classifyMemory(used:number,limit:number,soft=MEMORY_SOFT_RATIO,hard=MEMORY_HARD_RATIO):MemoryBudget{
  const ratio=limit>0?used/limit:0;
  return {used,limit,ratio,level:ratio>=hard?'pressure':ratio>=soft?'waiting':'safe'};
}

export function reclaimableFileCache(stat:string):number{
  const values=new Map(stat.split(/\r?\n/).map(line=>line.trim().split(/\s+/)).filter(parts=>parts.length===2).map(parts=>[parts[0]!,Number(parts[1])||0]));
  return Math.max(0,values.get('inactive_file')??values.get('total_inactive_file')??0);
}

export async function readMemoryBudget():Promise<MemoryBudget|null>{
  for(const [usedPath,limitPath,statPath] of paths){
    try{
      const [usedText,limitText,statText]=await Promise.all([readFile(usedPath,'utf8'),readFile(limitPath,'utf8'),readFile(statPath,'utf8').catch(()=>'')]);
      const rawUsed=Number(usedText.trim()),limit=Number(limitText.trim()),used=Math.max(0,rawUsed-reclaimableFileCache(statText));
      if(Number.isFinite(rawUsed)&&Number.isFinite(limit)&&rawUsed>=0&&limit>0&&limit<Number.MAX_SAFE_INTEGER)return classifyMemory(used,limit);
    }catch{}
  }
  return null;
}

const delay=(ms:number,signal?:AbortSignal)=>new Promise<void>((resolve,reject)=>{
  const finish=()=>{signal?.removeEventListener('abort',abort);resolve();};
  const timer=setTimeout(finish,ms);
  const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal?.reason??new Error('Aborted'));};
  signal?.addEventListener('abort',abort,{once:true});
});

/** Wait only between durable stages. The active encoder is never killed at a threshold. */
export async function waitForMemory(signal?:AbortSignal,onWait?:(budget:MemoryBudget)=>void):Promise<MemoryBudget|null>{
  let last:MemoryBudget|null=null;
  while(true){
    signal?.throwIfAborted();
    last=await readMemoryBudget();
    if(!last||last.level==='safe')return last;
    onWait?.(last);
    await delay(last.level==='pressure'?4000:2000,signal);
  }
}
