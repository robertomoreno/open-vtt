// @vitest-environment jsdom
import { expect,it,vi } from 'vitest';
import { mountApp } from '../../src/ui/app';
import { createConnectionView } from '../../src/ui/connection';
import { createRepository } from '../../src/storage/repository';
import { memoryStorage } from '../helpers/storage';
import { runtime } from '../helpers/game';
import { encodeSignal,type Signal } from '../../src/network/signaling';
import { pair } from '../helpers/transport';
const offer:Signal={version:1,kind:'offer',invitationId:'i',description:{type:'offer',sdp:'sdp'}};
const environment={canCreate:true,canConnect:true,message:''};
it('keeps copy failures usable with selectable text',async()=>{
 document.body.innerHTML='<main></main>';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:vi.fn().mockRejectedValue(new Error('denied'))}});
 const view=createConnectionView(document.querySelector('main')!,{create:()=>{},accept:()=>{},cancel:()=>{}});view.update({kind:'guest',phase:'waiting',output:'https://example/#reply=abc',message:'Send this reply to your host'});document.querySelector<HTMLButtonElement>('#copy-signal')!.click();await vi.waitFor(()=>expect(document.body.textContent).toContain('Select and copy'));const output=document.querySelector<HTMLTextAreaElement>('#signal-output')!;expect(output.readOnly).toBe(true);expect(output.selectionEnd).toBe(output.value.length);view.destroy();
});
it('discloses STUN before creation, cancels and generates separate invitations',async()=>{
 document.body.innerHTML='<main></main>';let n=0;const transports=[] as ReturnType<typeof pair>[0][];const create=vi.fn(async()=>{const [transport]=pair();transports.push(transport);const signal={...offer,invitationId:`i${++n}`};return {invitationId:signal.invitationId,offer:signal,transport,accept:async()=>{},cancel:()=>transport.close()};});
 const app=mountApp(document.querySelector('main')!,{repository:createRepository(memoryStorage()),runtime:runtime(),environment,network:{createInvitation:create}});
 document.querySelector<HTMLInputElement>('#game-name')!.value='Game';document.querySelector<HTMLInputElement>('#creator-name')!.value='Alex';document.querySelector<HTMLFormElement>('#new-game')!.requestSubmit();document.querySelector<HTMLButtonElement>('#invite')!.click();expect(create).not.toHaveBeenCalled();expect(document.body.textContent).toContain('STUN');document.querySelector<HTMLButtonElement>('#create-signal')!.click();await vi.waitFor(()=>expect(document.querySelector('#signal-output')).not.toBeNull());expect(document.querySelector<HTMLTextAreaElement>('#signal-output')!.value).toContain('#invite=');document.querySelector<HTMLButtonElement>('#cancel-connection')!.click();expect(transports[0].state).toBe('closed');document.querySelector<HTMLButtonElement>('#invite')!.click();document.querySelector<HTMLButtonElement>('#create-signal')!.click();await vi.waitFor(()=>expect(create).toHaveBeenCalledTimes(2));app.destroy();
});
it('consumes invitation hash without network discovery and explains expired replies',async()=>{
 document.body.innerHTML='<main></main>';history.replaceState(null,'','#invite='+encodeSignal(offer));const answer=vi.fn();const app=mountApp(document.querySelector('main')!,{repository:createRepository(memoryStorage()),runtime:runtime(),environment,network:{answerInvitation:answer}});expect(location.hash).toBe('');expect(answer).not.toHaveBeenCalled();expect(document.body.textContent).toContain('Create reply');app.destroy();
 history.replaceState(null,'','#reply='+encodeSignal({...offer,kind:'answer',description:{type:'answer',sdp:'x'}}));const next=mountApp(document.querySelector('main')!,{repository:createRepository(memoryStorage()),runtime:runtime(),environment});expect(document.body.textContent).toMatch(/expired.*host tab/i);expect(document.querySelector('#new-game')).not.toBeNull();next.destroy();
});
