// @vitest-environment jsdom
import { beforeEach,expect,it,vi } from 'vitest';
import { mountApp } from '../../src/ui/app';
import { createRepository } from '../../src/storage/repository';
import { memoryStorage } from '../helpers/storage';
import { fixtureGame,runtime } from '../helpers/game';
beforeEach(()=>{document.body.innerHTML='<main id="root"></main>';});
const root=()=>document.querySelector<HTMLElement>('#root')!;
const fill=(id:string,value:string)=>{document.querySelector<HTMLInputElement>(`#${id}`)!.value=value;};
it('creates an accessible locally saved game and rolls without peers',()=>{
 const repo=createRepository(memoryStorage());const app=mountApp(root(),{repository:repo,runtime:runtime()});
 expect(document.querySelector('label[for="game-name"]')?.textContent).toBe('Game name');fill('game-name','Lantern');fill('creator-name','Alex');document.querySelector<HTMLFormElement>('#new-game')!.requestSubmit();
 expect(root().textContent).toContain('Lantern');document.querySelector<HTMLButtonElement>('#roll')!.click();expect(repo.list().games[0].rolls).toHaveLength(1);app.destroy();
});
it('keeps unsaved state and export available when leave is declined and remounts cleanly',()=>{
 const repo=createRepository(new Proxy({} as Storage,{get(){throw new Error('denied');}})),confirm=vi.fn(()=>false),download=vi.fn();const app=mountApp(root(),{repository:repo,runtime:runtime(),confirm,download});
 fill('game-name','Unsaved');fill('creator-name','Alex');document.querySelector<HTMLFormElement>('#new-game')!.requestSubmit();document.querySelector<HTMLButtonElement>('#leave')!.click();expect(confirm).toHaveBeenCalledOnce();expect(document.querySelector('#roll')).not.toBeNull();document.querySelector<HTMLButtonElement>('#download')!.click();expect(download).toHaveBeenCalledOnce();expect(root().textContent).toContain('Browser save unavailable');
 const next=mountApp(root(),{repository:createRepository(memoryStorage()),runtime:runtime()});expect(document.querySelectorAll('#new-game')).toHaveLength(1);app.destroy();next.destroy();
});
it('shows independent saves and corrupt-record warnings',()=>{
 const storage=memoryStorage();const repo=createRepository(storage);repo.save(fixtureGame());repo.save({...fixtureGame(),id:'two',name:'Other'});storage.setItem('gather:game:bad','invalid');
 const app=mountApp(root(),{repository:repo,runtime:runtime()});expect(root().textContent).toContain('Lantern Road');expect(root().textContent).toContain('Other');expect(root().textContent).toContain('corrupt');app.destroy();
});
it('explains unavailable APIs and safely disables creation without crypto',()=>{
 const app=mountApp(root(),{repository:createRepository(memoryStorage()),runtime:runtime(),environment:{canCreate:false,canConnect:false,message:'Use HTTPS or localhost with Web Crypto and WebRTC.'}});
 expect(root().textContent).toContain('HTTPS or localhost');expect(document.querySelector<HTMLButtonElement>('#create-game')!.disabled).toBe(true);app.destroy();
});
