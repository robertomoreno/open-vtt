import { check, object, id } from '../game/validation';
export type Signal={version:1;kind:'offer'|'answer';invitationId:string;description:{type:'offer'|'answer';sdp:string}};
export const bytes=(value:string)=>new TextEncoder().encode(value).length;
export function validateSignal(value:unknown):Signal {
 const s=object(value,['version','kind','invitationId','description']); check(s.version===1,'Unsupported connection version.');check(s.kind==='offer'||s.kind==='answer','Invalid connection kind.');
 const d=object(s.description,['type','sdp']);check(d.type===s.kind && typeof d.sdp==='string' && d.sdp.length>0 && bytes(d.sdp)<=65536,'Invalid or oversized session description.');
 return {version:1,kind:s.kind,invitationId:id(s.invitationId),description:{type:s.kind,sdp:d.sdp}};
}
export function encodeSignal(signal:Signal):string {
 const data=new TextEncoder().encode(JSON.stringify(validateSignal(signal)));let binary='';for(const n of data)binary+=String.fromCharCode(n);
 const code=btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');check(code.length<=131072,'Connection code is too long.');return code;
}
export function decodeSignal(input:string):Signal {
 check(input.length<=131072,'Connection code is too long.');let code=input.trim(), kind:string|undefined;
 if(code.includes('#')) {const url=new URL(code);const hash=url.hash.slice(1);const match=/^(invite|reply)=([\w-]+)$/.exec(hash);check(match,'Invalid connection link.');kind=match[1];code=match[2];}
 check(/^[\w-]+$/.test(code),'Paste a complete invitation or reply code.');
 let value:unknown;try{const binary=atob(code.replace(/-/g,'+').replace(/_/g,'/'));value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(binary,c=>c.charCodeAt(0))));}catch{throw new Error('Malformed connection code.');}
 const signal=validateSignal(value);check(!kind || (kind==='invite'?signal.kind==='offer':signal.kind==='answer'),'This link contains the wrong connection kind.');return signal;
}
export function signalLink(signal:Signal,baseUrl:string):string {const url=new URL(baseUrl);url.hash=`${signal.kind==='offer'?'invite':'reply'}=${encodeSignal(signal)}`;return url.href;}
