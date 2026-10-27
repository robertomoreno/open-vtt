import { expect, it } from 'vitest';
import { createRepository } from '../../src/storage/repository';
import { fixtureGame } from '../helpers/game';
import { memoryStorage } from '../helpers/storage';
it('round trips independent games and identity hints',()=>{
 const repo=createRepository(memoryStorage()); const g=fixtureGame(); repo.save(g); repo.save({...g,id:'second',name:'🌿'}); repo.rememberPlayer(g.id,'alex');
 expect(repo.list().games).toHaveLength(2); expect(repo.get(g.id)).toEqual(g); expect(repo.rememberedPlayer(g.id)).toBe('alex');
});
it('survives one corrupt record and reports it',()=>{
 const storage=memoryStorage(); const repo=createRepository(storage); repo.save(fixtureGame()); storage.setItem('gather:game:bad','{oops');
 expect(repo.list().games).toHaveLength(1); expect(repo.list().warnings).toHaveLength(1);
});
it('returns save warning on denied storage or quota',()=>{
 const storage=new Proxy({} as Storage,{get(){throw new Error('denied');}}); const repo=createRepository(storage);
 expect(repo.save(fixtureGame()).ok).toBe(false); expect(repo.rememberPlayer('g','p').ok).toBe(false); expect(repo.list().warnings).toHaveLength(1); expect(repo.get('g')).toBeNull();
});
