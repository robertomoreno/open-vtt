// @vitest-environment jsdom
import { expect,it,vi } from 'vitest';
import { createRoomView } from '../../src/ui/room';
import { createHostSession } from '../../src/session/host';
import { fixtureGame,runtime } from '../helpers/game';
it('renders untrusted names as text and exposes export and labeled presence',()=>{
 document.body.innerHTML='<main></main>';const game=fixtureGame();game.players[0].name='<img onerror=alert(1)>';const h=createHostSession(game,'alex',runtime());const download=vi.fn();const view=createRoomView(document.querySelector('main')!,h.getView(),{roll:()=>{},download,leave:()=>{},invite:()=>{},approve:()=>{},reject:()=>{}});
 expect(document.querySelector('img')).toBeNull();expect(document.body.textContent).toContain('<img onerror=alert(1)>');expect(document.body.textContent).toContain('Online');document.querySelector<HTMLButtonElement>('#download')!.click();expect(download).toHaveBeenCalledOnce();view.destroy();h.close();
});
it('preserves die selection and focus on updates and labels guest snapshots last-received',()=>{
 document.body.innerHTML='<main></main>';const host=createHostSession(fixtureGame(),'alex',runtime()),state=host.getView();state.mode='guest';const view=createRoomView(document.querySelector('main')!,state,{roll:()=>{},download:()=>{},leave:()=>{},invite:()=>{},approve:()=>{},reject:()=>{}});
 const die=document.querySelector<HTMLSelectElement>('#die')!;die.value='6';die.focus();view.update({...state,phase:'disconnected'});expect(die.value).toBe('6');expect(document.activeElement).toBe(die);expect(document.body.textContent).toContain('Last received state');expect(document.querySelector<HTMLButtonElement>('#roll')!.disabled).toBe(true);view.destroy();host.close();
});
