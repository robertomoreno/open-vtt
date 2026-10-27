// @vitest-environment jsdom
import { expect,it,vi } from 'vitest';
import { mountApp } from '../../src/ui/app';
import { createRepository } from '../../src/storage/repository';
import { memoryStorage } from '../helpers/storage';
import { fixtureGame,runtime } from '../helpers/game';
function setup(parseFile?:()=>Promise<ReturnType<typeof fixtureGame>>){document.body.innerHTML='<main></main>';const root=document.querySelector('main')!,repo=createRepository(memoryStorage());repo.save(fixtureGame());repo.rememberPlayer('game','alex');const app=mountApp(root,{repository:repo,runtime:runtime(),parseFile});return {root,repo,app};}
it('suggests remembered existing player and restores without changing IDs',()=>{
 const{root,repo,app}=setup();root.querySelector<HTMLButtonElement>('[data-game]')!.click();expect(root.querySelector<HTMLSelectElement>('#restore-player')!.value).toBe('alex');root.querySelector<HTMLFormElement>('form')!.requestSubmit();expect(repo.get('game')?.players[0].id).toBe('alex');expect(root.textContent).toContain('Host');app.destroy();
});
it('creates a new hosting GM on restore',()=>{
 const{root,repo,app}=setup();root.querySelector<HTMLButtonElement>('[data-game]')!.click();root.querySelector<HTMLSelectElement>('#restore-player')!.value='new';root.querySelector<HTMLInputElement>('#restore-name')!.value='Bea';root.querySelector<HTMLFormElement>('form')!.requestSubmit();expect(repo.get('game')?.players[1]).toMatchObject({name:'Bea',role:'gm'});app.destroy();
});
it('previews replacement, cancel preserves existing game, and invalid files never write',async()=>{
 const parse=vi.fn().mockResolvedValueOnce({...fixtureGame(),name:'Imported'}).mockRejectedValueOnce(new Error('Invalid file'));
 const{root,repo,app}=setup(parse);let input=root.querySelector<HTMLInputElement>('#import-file')!;Object.defineProperty(input,'files',{value:[new File(['{}'],'game.json')]});input.dispatchEvent(new Event('change'));await vi.waitFor(()=>expect(root.textContent).toContain('Replace saved game and open'));
 root.querySelector<HTMLButtonElement>('#cancel-restore')!.click();expect(repo.get('game')?.name).toBe('Lantern Road');
 input=root.querySelector<HTMLInputElement>('#import-file')!;Object.defineProperty(input,'files',{value:[new File(['{}'],'bad.json')]});input.dispatchEvent(new Event('change'));await vi.waitFor(()=>expect(root.textContent).toContain('Invalid file'));expect(repo.get('game')?.name).toBe('Lantern Road');app.destroy();
});
it('does not replace a newly created live view with an earlier slow import',async()=>{
 let resolve!:(game:ReturnType<typeof fixtureGame>)=>void;const pending=new Promise<ReturnType<typeof fixtureGame>>(done=>{resolve=done;});const {root,app}=setup(()=>pending);
 const input=root.querySelector<HTMLInputElement>('#import-file')!;Object.defineProperty(input,'files',{value:[new File(['{}'],'game.json')]});input.dispatchEvent(new Event('change'));
 root.querySelector<HTMLInputElement>('#game-name')!.value='New live game';root.querySelector<HTMLInputElement>('#creator-name')!.value='Alex';root.querySelector<HTMLFormElement>('#new-game')!.requestSubmit();resolve(fixtureGame());await pending;await Promise.resolve();
 expect(root.querySelector('#roll')).not.toBeNull();expect(root.textContent).toContain('New live game');app.destroy();
});
