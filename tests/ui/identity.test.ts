// @vitest-environment jsdom
import { expect,it,vi } from 'vitest';
import { createIdentityView } from '../../src/ui/identity';
import { mountApp } from '../../src/ui/app';
import { createRepository } from '../../src/storage/repository';
import { memoryStorage } from '../helpers/storage';
import { runtime } from '../helpers/game';
import { pair } from '../helpers/transport';
import { encodeSignal,type Signal } from '../../src/network/signaling';
it('suggests remembered available identities but excludes occupied players',()=>{
 document.body.innerHTML='<main></main>';const claim=vi.fn();const lobby={sessionId:'s',gameId:'g',gameName:'Game',players:[{id:'a',name:'Alex',role:'gm' as const,online:true},{id:'b',name:'Bea',role:'pj' as const,online:false}]};
 const view=createIdentityView(document.querySelector('main')!,lobby,'b',{claim});expect(document.querySelector<HTMLSelectElement>('#claim-player')!.value).toBe('b');expect(document.querySelector<HTMLOptionElement>('option[value=a]')!.disabled).toBe(true);document.querySelector<HTMLButtonElement>('#claim-existing')!.click();expect(claim).toHaveBeenCalledWith({playerId:'b'});expect(document.body.textContent).toContain('not proof of identity');view.destroy();
});
it('retries rejected claims, stores hints only after approval and exports after host loss',async()=>{
 document.body.innerHTML='<main id="host"></main><main id="guest"></main>';const host=document.querySelector<HTMLElement>('#host')!,guest=document.querySelector<HTMLElement>('#guest')!;
 const peers=pair('connecting'),[a,b]=peers,offer:Signal={version:1,kind:'offer',invitationId:'i',description:{type:'offer',sdp:'sdp'}},reply:Signal={...offer,kind:'answer',description:{type:'answer',sdp:'answer'}};
 const environment={canCreate:true,canConnect:true,message:''},repo=createRepository(memoryStorage()),download=vi.fn();
 const h=mountApp(host,{repository:createRepository(memoryStorage()),runtime:runtime(),environment,network:{createInvitation:async()=>({invitationId:'i',offer,transport:a,accept:async()=>{peers.open();},cancel:()=>a.close()})}});
 const g=mountApp(guest,{repository:repo,runtime:runtime(),environment,download,network:{answerInvitation:async()=>({reply,transport:b})}});
 host.querySelector<HTMLInputElement>('#game-name')!.value='Game';host.querySelector<HTMLInputElement>('#creator-name')!.value='Alex';host.querySelector<HTMLFormElement>('#new-game')!.requestSubmit();host.querySelector<HTMLButtonElement>('#invite')!.click();host.querySelector<HTMLButtonElement>('#create-signal')!.click();
 guest.querySelector<HTMLTextAreaElement>('[id=join-code]')!.value=encodeSignal(offer);guest.querySelector('[id=join-code]')!.closest('form')!.requestSubmit();expect(guest.textContent).toContain('Create reply');guest.querySelector<HTMLButtonElement>('[id=create-signal]')!.click();await vi.waitFor(()=>expect(host.querySelector('[id=reply-code]')).not.toBeNull());
 host.querySelector<HTMLTextAreaElement>('[id=reply-code]')!.value=encodeSignal(reply);host.querySelector<HTMLButtonElement>('[id=accept-reply]')!.click();await vi.waitFor(()=>expect(guest.querySelector('[id=claim-name]')).not.toBeNull());
 guest.querySelector<HTMLInputElement>('#claim-name')!.value='Bea';guest.querySelector('#claim-name')!.closest('form')!.requestSubmit();expect(repo.rememberedPlayer('id-1')).toBeNull();
 [...host.querySelectorAll('button')].find(b=>b.textContent==='Reject')!.click();expect(guest.textContent).toContain('declined');expect(guest.querySelector<HTMLInputElement>('[id=claim-name]')!.value).toBe('Bea');guest.querySelector('[id=claim-name]')!.closest('form')!.requestSubmit();[...host.querySelectorAll('button')].find(b=>b.textContent==='Approve')!.click();expect(guest.querySelector('[id=roll]')).not.toBeNull();expect(repo.rememberedPlayer('id-1')).not.toBeNull();h.destroy();expect(guest.querySelector<HTMLButtonElement>('[id=roll]')!.disabled).toBe(true);guest.querySelector<HTMLButtonElement>('[id=download]')!.click();expect(download).toHaveBeenCalledOnce();g.destroy();
});
