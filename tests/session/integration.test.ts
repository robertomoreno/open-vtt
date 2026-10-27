import { expect,it } from 'vitest';
import { createHostSession } from '../../src/session/host';
import { createGuestSession } from '../../src/session/guest';
import { fixtureGame,runtime } from '../helpers/game';
import { pair } from '../helpers/transport';
function setup(){return createHostSession(fixtureGame(),'alex',runtime());}
it.each([true,false])('handshakes in either attachment order (%s)',hostFirst=>{
 const h=setup(),[a,b]=pair();let g;
 if(hostFirst){h.attach(a);g=createGuestSession(b,runtime());}else{g=createGuestSession(b,runtime());h.attach(a);}
 expect(g.getView().lobby?.gameName).toBe('Lantern Road');h.close();
});
it('synchronizes two approved guests and late join history exactly once',()=>{
 const h=setup();const guests=['Bea','Cy'].map(name=>{const [a,b]=pair();const g=createGuestSession(b,runtime());h.attach(a);g.claim({newPlayer:{name,role:'pj'}});const pending=h.getView().pendingClaims[0];h.approve(pending.peerId,pending.requestId);return g;});
 h.roll(20);guests[0].roll(6);guests[1].roll(8);
 expect(h.getView().game?.rolls).toHaveLength(3);for(const g of guests)expect(g.getView().game).toEqual(h.getView().game);
 const [a,b]=pair(),late=createGuestSession(b,runtime());h.attach(a);late.claim({newPlayer:{name:'Dee',role:'gm'}});const p=h.getView().pendingClaims[0];h.approve(p.peerId,p.requestId);expect(late.getView().game?.rolls).toHaveLength(3);expect('approve' in late).toBe(false);h.close();
});
it('never accepts guest state, spoofed identity, unapproved rolls or duplicate requests',()=>{
 const h=setup(),[a,b]=pair();const g=createGuestSession(b,runtime());h.attach(a);b.send({type:'roll-request',requestId:'early',sides:20});expect(h.getView().game?.rolls).toHaveLength(0);
 g.claim({newPlayer:{name:'Bea',role:'pj'}});const p=h.getView().pendingClaims[0];h.approve(p.peerId,p.requestId);
 b.send({type:'roll-request',requestId:'roll1',sides:20});b.send({type:'roll-request',requestId:'roll1',sides:20});expect(h.getView().game?.rolls).toHaveLength(1);
 b.send({type:'roll-request',requestId:'spoof',sides:20,playerId:'alex',value:20});expect(h.getView().game?.rolls).toHaveLength(1);h.close();
});
it('approves at most one concurrent claim and rejection creates no orphan',()=>{
 const game=fixtureGame();game.players.push({id:'bea',name:'Bea',role:'pj'});const h=createHostSession(game,'alex',runtime());
 const gs=[0,1].map(()=>{const[a,b]=pair();const g=createGuestSession(b,runtime());h.attach(a);g.claim({playerId:'bea'});return g;});
 const pending=h.getView().pendingClaims;h.approve(pending[0].peerId,pending[0].requestId);h.approve(pending[1].peerId,pending[1].requestId);
 expect(gs.filter(g=>g.getView().phase==='ready')).toHaveLength(1);expect(h.getView().game?.players).toHaveLength(2);h.close();
});
it('applies presence-only sequence changes but rejects stale revisions and foreign sessions',()=>{
 const [a,b]=pair();const g=createGuestSession(b,runtime());const game=fixtureGame();
 a.send({type:'lobby',lobby:{sessionId:'s',gameId:'game',gameName:game.name,players:game.players.map(p=>({...p,online:false}))}});
 g.claim({playerId:'alex'});a.send({type:'claim-result',requestId:'id-1',status:'approved',playerId:'alex'});
 const send=(sequence:number,revision:number,sessionId='s',onlinePlayerIds=['alex'])=>a.send({type:'snapshot',snapshot:{sessionId,sequence,game:{...game,revision},onlinePlayerIds}});
 send(1,2);send(2,2,'s',[]);expect(g.getView().onlinePlayerIds).toEqual([]);send(1,2);expect(g.getView().onlinePlayerIds).toEqual([]);send(3,1);expect(g.getView().game?.revision).toBe(2);send(4,4,'wrong');expect(g.getView().game?.revision).toBe(2);g.close();
});
