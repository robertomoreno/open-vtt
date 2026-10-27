import { expect,it,vi,afterEach } from 'vitest';
import { createInvitation,answerInvitation } from '../../src/network/peer';
class Channel extends EventTarget {label='gather-v1';ordered=true;maxRetransmits=null;maxPacketLifeTime=null;readyState='connecting';bufferedAmount=0;send=vi.fn();close(){this.readyState='closed';this.dispatchEvent(new Event('close'));}}
class RTC extends EventTarget {
 iceGatheringState='gathering';connectionState='new';localDescription={type:'offer',sdp:'sdp'};channel=new Channel(); close=vi.fn();
 createDataChannel(){return this.channel;} async createOffer(){return {type:'offer',sdp:'sdp'};} async createAnswer(){return {type:'answer',sdp:'sdp'};}
 async setLocalDescription(d:{type:string;sdp:string}){this.localDescription=d;} async setRemoteDescription(){}
 complete(){this.iceGatheringState='complete';this.dispatchEvent(new Event('icegatheringstatechange'));}
}
afterEach(()=>vi.useRealTimers());
it('waits for complete ICE then rejects wrong and reused answers',async()=>{
 const rtc=new RTC(); let done=false;const pending=createInvitation({rtcFactory:()=>rtc as unknown as RTCPeerConnection}).then(x=>{done=true;return x;});
 await Promise.resolve();expect(done).toBe(false);rtc.complete();const invite=await pending;
 const answer={...invite.offer,kind:'answer' as const,description:{type:'answer' as const,sdp:'answer'}};
 await expect(invite.accept({...answer,invitationId:'wrong'})).rejects.toThrow();await invite.accept(answer);await expect(invite.accept(answer)).rejects.toThrow();invite.cancel();invite.cancel();expect(rtc.close).toHaveBeenCalledTimes(1);
});
it('handles already complete gathering and removes timers on close',async()=>{
 vi.useFakeTimers();const rtc=new RTC();rtc.complete();const invite=await createInvitation({rtcFactory:()=>rtc as unknown as RTCPeerConnection});invite.cancel();expect(vi.getTimerCount()).toBe(0);
});
it('cancels gathering, times out and cleans up',async()=>{
 const rtc=new RTC(),abort=new AbortController();const p=createInvitation({signal:abort.signal,rtcFactory:()=>rtc as unknown as RTCPeerConnection});abort.abort();await expect(p).rejects.toThrow();expect(rtc.close).toHaveBeenCalledTimes(1);
 vi.useFakeTimers();const other=new RTC();const timeout=createInvitation({rtcFactory:()=>other as unknown as RTCPeerConnection});const assertion=expect(timeout).rejects.toThrow(/timed out/i);await vi.advanceTimersByTimeAsync(30001);await assertion;expect(vi.getTimerCount()).toBe(0);
});
it('fails channel errors, validates frames and reports backpressure',async()=>{
 const rtc=new RTC();rtc.complete();const invite=await createInvitation({rtcFactory:()=>rtc as unknown as RTCPeerConnection});rtc.channel.readyState='open';rtc.channel.dispatchEvent(new Event('open'));expect(invite.transport.state).toBe('open');rtc.channel.bufferedAmount=1048576;expect(()=>invite.transport.send({x:1})).toThrow();rtc.channel.dispatchEvent(new Event('error'));expect(invite.transport.state).toBe('failed');
});
it('rejects answering an answer before constructing a peer',async()=>{
 await expect(answerInvitation({version:1,kind:'answer',invitationId:'i',description:{type:'answer',sdp:'x'}})).rejects.toThrow();
});
