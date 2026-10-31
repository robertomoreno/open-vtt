// @vitest-environment jsdom
import { expect,it,vi } from 'vitest';
import { mountApp } from '../../src/ui/app';
import type { PeerTransport,TransportEvent,TransportState } from '../../src/network/peer';
import { encodeSignal,type Signal } from '../../src/network/signaling';
import { createRepository } from '../../src/storage/repository';
import { memoryStorage } from '../helpers/storage';
import { runtime } from '../helpers/game';

it.each(['host','guest'] as const)('retains the underlying failure after a %s transport becomes failed/closed',async mode=>{
 document.body.innerHTML='<main></main>';const root=document.querySelector('main')!;
 const listeners=new Set<(event:TransportEvent)=>void>();let state:TransportState='connecting';
 const transport:PeerTransport={id:'peer',get state(){return state;},send(){},subscribe(fn){listeners.add(fn);return ()=>{listeners.delete(fn);};},close(){state='closed';for(const fn of [...listeners])fn({type:'state',state});}};
 const offer:Signal={version:1,kind:'offer',invitationId:'i',description:{type:'offer',sdp:'offer'}};
 const app=mountApp(root,{repository:createRepository(memoryStorage()),runtime:runtime(),environment:{canCreate:true,canConnect:true,message:''},network:{
  createInvitation:async()=>({invitationId:'i',offer,transport,accept:async()=>{},cancel:()=>transport.close()}),
  answerInvitation:async()=>({reply:{...offer,kind:'answer',description:{type:'answer',sdp:'answer'}},transport})
 }});
 if(mode==='host'){
  root.querySelector<HTMLInputElement>('#game-name')!.value='Game';root.querySelector<HTMLInputElement>('#creator-name')!.value='Alex';root.querySelector<HTMLFormElement>('#new-game')!.requestSubmit();root.querySelector<HTMLButtonElement>('#invite')!.click();
 }else{
  root.querySelector<HTMLTextAreaElement>('#join-code')!.value=encodeSignal(offer);root.querySelector('#join-code')!.closest('form')!.requestSubmit();
 }
 root.querySelector<HTMLButtonElement>('#create-signal')!.click();await vi.waitFor(()=>expect(root.querySelector<HTMLTextAreaElement>('#signal-output')!.value).not.toBe(''));
 const reason='Direct connection timed out. ICE: checking; peer: connecting; channel: connecting.';
 for(const fn of [...listeners])fn({type:'error',message:reason});state='failed';for(const fn of [...listeners])fn({type:'state',state});transport.close();
 expect(root.querySelector('#connection-flow')!.textContent).toContain(reason);expect(root.querySelector('#connection-flow')!.textContent).not.toContain('Connection closed or invitation expired.');app.destroy();
});
