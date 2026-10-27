import { check,object,id,integer } from '../game/validation';
import { bytes } from './signaling';
export function encodeFrames(value:unknown):string[] {
 const data=JSON.stringify(value);check(typeof data==='string' && bytes(data)<=262144,'Message exceeds 256 KiB.');
 const transfer=crypto.randomUUID(), count=Math.ceil(data.length/3000);check(count<=128,'Too many message frames.');
 return Array.from({length:count},(_,index)=>JSON.stringify({transfer,index,count,data:data.slice(index*3000,(index+1)*3000)}));
}
export function createAssembler(now:()=>number=Date.now) {
 const transfers=new Map<string,{count:number;at:number;size:number;chunks:Map<number,string>}>();
 return { clear:()=>transfers.clear(),accept(frame:string):unknown|undefined {
   check(typeof frame==='string' && bytes(frame)<=16384,'Invalid frame size.');
   const f=object(JSON.parse(frame),['transfer','index','count','data']);const transfer=id(f.transfer), index=integer(f.index), count=integer(f.count,1);
   check(count<=128 && index<count && typeof f.data==='string' && f.data.length<=3000,'Invalid frame bounds.');
   const existing=transfers.get(transfer);check(!existing || now()-existing.at<=10000,'Message transfer expired.');
   for(const [key,t]of transfers)if(now()-t.at>10000)transfers.delete(key);
   check(existing || transfers.size<4,'Too many incomplete messages.');
   const t=existing??{count,at:now(),size:0,chunks:new Map<number,string>()};
   check(t.count===count && !t.chunks.has(index),'Duplicate or inconsistent frame.');t.size+=bytes(f.data);check(t.size<=262144,'Message exceeds 256 KiB.');t.chunks.set(index,f.data);transfers.set(transfer,t);
   if(t.chunks.size!==count)return undefined;transfers.delete(transfer);
   return JSON.parse(Array.from({length:count},(_,n)=>t.chunks.get(n)!).join(''));
 }};
}
