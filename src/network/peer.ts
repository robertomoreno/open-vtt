import { check } from '../game/validation';
import { encodeFrames,createAssembler } from './framing';
import { validateSignal,type Signal,bytes } from './signaling';
import { rtcConfiguration } from './config';
export type TransportState='connecting'|'open'|'disconnected'|'failed'|'closed';
export type TransportEvent={type:'state';state:TransportState}|{type:'message';value:unknown}|{type:'error';message:string};
export type PeerTransport={readonly id:string;readonly state:TransportState;send(value:unknown):void;subscribe(listener:(event:TransportEvent)=>void):()=>void;close():void};
export type PeerOptions={signal?:AbortSignal;rtcFactory?:()=>RTCPeerConnection};
export type PendingInvitation={invitationId:string;offer:Signal;transport:PeerTransport;accept(answer:Signal):Promise<void>;cancel():void};
const manualExchangeTimeout=10*60*1000;
const postAcceptTimeout=45*1000;
function makePeer(options:PeerOptions) {
 check(!options.signal?.aborted,'Connection canceled.');
 const rtc=options.rtcFactory?.()??new RTCPeerConnection(rtcConfiguration);
 const listeners=new Set<(e:TransportEvent)=>void>(), cleanups:Array<()=>void>=[], timers=new Set<ReturnType<typeof setTimeout>>(), assembler=createAssembler();
 let state:TransportState='connecting',channel:RTCDataChannel|undefined,disposed=false,failureMessage:string|null=null;
 const emit=(event:TransportEvent)=>{for(const listener of [...listeners])listener(event);};
 function on(target:EventTarget,type:string,listener:EventListener){target.addEventListener(type,listener);cleanups.push(()=>target.removeEventListener(type,listener));}
 function timer(callback:()=>void,ms:number){const handle=setTimeout(()=>{timers.delete(handle);callback();},ms);timers.add(handle);return ()=>{clearTimeout(handle);timers.delete(handle);};}
 function setState(next:TransportState){if(state!==next){state=next;emit({type:'state',state});}}
 function dispose(next:'closed'|'failed',message?:string){
   if(disposed)return;
   // Capture only state labels before cleanup changes them. Never include SDP,
   // candidate addresses, or temporary connection credentials in diagnostics.
   failureMessage=message?`${message} ICE: ${rtc.iceConnectionState??'unknown'}; peer: ${rtc.connectionState}; channel: ${channel?.readyState??'not received'}.`:null;
   disposed=true;for(const fn of cleanups.splice(0))fn();for(const t of timers)clearTimeout(t);timers.clear();assembler.clear();channel?.close();rtc.close();
   if(failureMessage)emit({type:'error',message:failureMessage});setState(next);listeners.clear();
 }
 const fail=(message:string)=>dispose('failed',message);
 function active(){check(!disposed,failureMessage??'Connection canceled or expired. Generate a new invitation.');}
 function deadline(ms:number,message:string):()=>void {
   if(state==='open')return ()=>{};
   const cancel=timer(()=>{unsubscribe();if(state!=='open')fail(message);},ms);
   const unsubscribe=transport.subscribe(event=>{
     if(event.type==='state'&&['open','closed','failed'].includes(event.state)){cancel();unsubscribe();}
   });
   return ()=>{cancel();unsubscribe();};
 }
 function bind(next:RTCDataChannel){
   if(disposed){next.close();return;}if(channel || next.label!=='gather-v1' || !next.ordered || next.maxRetransmits!==null || next.maxPacketLifeTime!==null){next.close();fail('Unexpected data channel.');return;}
   channel=next;
   on(next,'open',()=>{if(!disposed)setState('open');});on(next,'close',()=>dispose('closed','Connection closed. Use a fresh invitation to reconnect.'));on(next,'error',()=>fail('Data channel failed. Try a new invitation or another network.'));
   on(next,'message',((event:MessageEvent)=>{try {check(typeof event.data==='string','Expected text data.');const value=assembler.accept(event.data);if(value!==undefined)emit({type:'message',value});}catch{fail('Invalid or oversized network message.');}}) as EventListener);
   if(next.readyState==='open')setState('open');
 }
 on(rtc,'datachannel',((e:RTCDataChannelEvent)=>bind(e.channel)) as EventListener);
 on(rtc,'connectionstatechange',()=>{
   if(rtc.connectionState==='failed')fail('Direct connection failed. Restrictive networks may block WebRTC; no relay is available.');
   else if(rtc.connectionState==='closed')dispose('closed');
   else if(rtc.connectionState==='disconnected')setState('disconnected');
   else if(rtc.connectionState==='connected' && channel?.readyState==='open')setState('open');
 });
 const abort=()=>dispose('closed','Connection canceled.');if(options.signal)on(options.signal,'abort',abort);
 async function gather(description:RTCSessionDescriptionInit):Promise<RTCSessionDescriptionInit>{
   active();await rtc.setLocalDescription(description);active();
   if(rtc.iceGatheringState!=='complete')await new Promise<void>((resolve,reject)=>{
     const remove=()=>{rtc.removeEventListener('icegatheringstatechange',changed);unsub();cancel();};
     const changed=()=>{if(rtc.iceGatheringState==='complete'){remove();resolve();}};
      const unsub=transport.subscribe(event=>{if(event.type==='state'&&(event.state==='closed'||event.state==='failed')){remove();reject(new Error(failureMessage??'Connection canceled or timed out.'));}});
      const cancel=timer(()=>{remove();fail('ICE gathering timed out after 30 seconds. Generate a new invitation.');reject(new Error(failureMessage!));},30000);
     rtc.addEventListener('icegatheringstatechange',changed);cleanups.push(()=>rtc.removeEventListener('icegatheringstatechange',changed));changed();
   });active();check(rtc.localDescription?.sdp,'Missing session description.');return rtc.localDescription;
 }
 const transport:PeerTransport={id:crypto.randomUUID(),get state(){return state;},send(value){active();check(state==='open'&&channel?.readyState==='open','Connection is not open.');const frames=encodeFrames(value);check(channel.bufferedAmount+frames.reduce((n,f)=>n+bytes(f),0)<=1048576,'Send buffer full. Reconnect before sending more data.');for(const frame of frames)channel.send(frame);},subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);},close:()=>dispose('closed')};
 return {rtc,transport,bind,gather,active,deadline};
}
export async function createInvitation(options:PeerOptions={}):Promise<PendingInvitation>{
 const p=makePeer(options),invitationId=crypto.randomUUID();let consumed=false;
 try {
   p.bind(p.rtc.createDataChannel('gather-v1',{ordered:true}));
   const description=await p.gather(await p.rtc.createOffer());p.active();
   const offer=validateSignal({version:1,kind:'offer',invitationId,description:{type:description.type,sdp:description.sdp}});
   const expire=p.deadline(manualExchangeTimeout,'Invitation expired after 10 minutes. Generate a new invitation.');
   return {invitationId,offer,transport:p.transport,cancel:()=>p.transport.close(),async accept(value){const answer=validateSignal(value);check(answer.kind==='answer'&&answer.invitationId===invitationId,'Reply belongs to another invitation or host tab.');p.active();check(!consumed,'Reply already used. Generate a new invitation.');consumed=true;expire();try{await p.rtc.setRemoteDescription(answer.description);p.active();p.deadline(postAcceptTimeout,'Direct connection timed out 45 seconds after the host accepted the reply. Generate a fresh invitation to retry.');}catch(error){p.transport.close();throw error;}}};
 }catch(error){p.transport.close();throw error;}
}
export async function answerInvitation(value:Signal,options:PeerOptions={}):Promise<{reply:Signal;transport:PeerTransport}>{
 const offer=validateSignal(value);check(offer.kind==='offer','Expected an invitation, not a reply.');const p=makePeer(options);
 try {
   await p.rtc.setRemoteDescription(offer.description);const description=await p.gather(await p.rtc.createAnswer());p.active();
   const reply=validateSignal({version:1,kind:'answer',invitationId:offer.invitationId,description:{type:description.type,sdp:description.sdp}});
   // A generated answer is not an answer applied by the host. Allow time for
   // the manual copy/paste exchange; the host enforces the post-accept deadline.
   p.deadline(manualExchangeTimeout,'Reply expired while waiting for the host to complete the exchange. Ask for a fresh invitation.');
   return {reply,transport:p.transport};
 }catch(error){p.transport.close();throw error;}
}
