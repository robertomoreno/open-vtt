import { expect,it,vi } from 'vitest';
import { createHostSession } from '../../src/session/host';
import { createGuestSession } from '../../src/session/guest';
import { fixtureGame,runtime } from '../helpers/game';
import { pair } from '../helpers/transport';
it('releases disconnected ownership, invalidates claims and retains exportable guest state on host loss',()=>{
 const h=createHostSession(fixtureGame(),'alex',runtime());const[a,b]=pair();const g=createGuestSession(b,runtime());h.attach(a);g.claim({newPlayer:{name:'Bea',role:'pj'}});let p=h.getView().pendingClaims[0];h.approve(p.peerId,p.requestId);const id=g.getView().localPlayerId!;b.close();
 expect(h.getView().onlinePlayerIds).not.toContain(id);expect(h.getView().game?.players).toHaveLength(2);
 const[c,d]=pair();const next=createGuestSession(d,runtime());h.attach(c);next.claim({playerId:id});p=h.getView().pendingClaims[0];h.approve(p.peerId,p.requestId);expect(next.getView().phase).toBe('ready');h.close();h.close();expect(next.getView().phase).toBe('disconnected');expect(next.getView().game?.players).toHaveLength(2);next.roll(20);expect(next.getView().game?.rolls).toHaveLength(0);
});
it('limits unapproved connections to eight without affecting the host',()=>{
 const h=createHostSession(fixtureGame(),'alex',runtime());const pairs=Array.from({length:9},()=>pair());for(const[a]of pairs)h.attach(a);expect(pairs[8][0].state).toBe('closed');h.roll(20);expect(h.getView().game?.rolls).toHaveLength(1);h.close();
});
it('closes a flooding peer while keeping other players connected',()=>{
 const h=createHostSession(fixtureGame(),'alex',runtime());const[a,b]=pair();h.attach(a);for(let n=0;n<21;n++)b.send({type:'hello',version:1});expect(a.state).toBe('closed');expect(h.getView().phase).toBe('ready');h.close();
});
it('retains accepted IDs until 4096 then requests reconnect instead of permitting replay',()=>{
 vi.useFakeTimers();const h=createHostSession(fixtureGame(),'alex',runtime());const[a,b]=pair();const g=createGuestSession(b,runtime());h.attach(a);g.claim({newPlayer:{name:'Bea',role:'pj'}});const p=h.getView().pendingClaims[0];h.approve(p.peerId,p.requestId);
 for(let n=0;n<4097;n++){vi.setSystemTime(Date.now()+1000);b.send({type:'roll-request',requestId:`roll-${n}`,sides:20});}
 expect(h.getView().game?.revision).toBe(4097);expect(g.getView().error).toMatch(/reconnect/i);
 vi.setSystemTime(Date.now()+1000);b.send({type:'roll-request',requestId:'roll-0',sides:20});expect(h.getView().game?.revision).toBe(4097);h.close();vi.useRealTimers();
});
