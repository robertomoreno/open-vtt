// @vitest-environment jsdom
import { expect,it,vi } from 'vitest';
import { mountApp } from '../../src/ui/app';
import { createHostSession } from '../../src/session/host';
import { createRepository } from '../../src/storage/repository';
import { fixtureGame,runtime } from '../helpers/game';
import { memoryStorage } from '../helpers/storage';
import { pair } from '../helpers/transport';
import { encodeSignal,type Signal } from '../../src/network/signaling';
it.each([false,true])('protects conflicting local state until replacement is explicitly chosen (%s)',async replace=>{
 document.body.innerHTML='<main></main>';const root=document.querySelector('main')!,repo=createRepository(memoryStorage());
 const saved={...fixtureGame(),revision:10,rolls:[{id:'old-roll',playerId:'alex',sides:20 as const,value:17,at:'2026-10-27T12:00:00.000Z'}]};repo.save(saved);
 const host=createHostSession(fixtureGame(),'alex',runtime()),[a,b]=pair();const confirm=vi.fn(()=>replace),download=vi.fn();
 const offer:Signal={version:1,kind:'offer',invitationId:'i',description:{type:'offer',sdp:'sdp'}};
 const app=mountApp(root,{repository:repo,runtime:runtime(),confirm,download,environment:{canCreate:true,canConnect:true,message:''},network:{answerInvitation:async()=>({reply:{...offer,kind:'answer',description:{type:'answer',sdp:'answer'}},transport:b})}});
 root.querySelector<HTMLTextAreaElement>('#join-code')!.value=encodeSignal(offer);root.querySelector('#join-code')!.closest('form')!.requestSubmit();root.querySelector<HTMLButtonElement>('#create-signal')!.click();await Promise.resolve();host.attach(a);await vi.waitFor(()=>expect(root.querySelector('#claim-name')).not.toBeNull());
 root.querySelector<HTMLInputElement>('#claim-name')!.value='Bea';root.querySelector('#claim-name')!.closest('form')!.requestSubmit();const claim=host.getView().pendingClaims[0];host.approve(claim.peerId,claim.requestId);
 expect(confirm).toHaveBeenCalledOnce();expect(repo.get('game')?.revision).toBe(replace?1:10);host.roll(20);expect(repo.get('game')?.revision).toBe(replace?2:10);expect(confirm).toHaveBeenCalledOnce();root.querySelector<HTMLButtonElement>('#download')!.click();expect(download.mock.calls[0][0].revision).toBe(2);if(!replace)expect(root.textContent).toContain('existing local save was preserved');app.destroy();host.close();
});
