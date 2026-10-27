import type { Game,Runtime,DieSides } from '../game/types';
import { addPlayer,recordRoll } from '../game/model';
import { check,validateGame } from '../game/validation';
import type { PeerTransport } from '../network/peer';
import type { HostSession,Lobby,SessionView,PendingClaim } from './types';
import { parseMessage,type Message } from './messages';
export function createHostSession(initial:Game,localPlayerId:string,runtime:Runtime):HostSession {
 let game=validateGame(initial);check(game.players.some(p=>p.id===localPlayerId),'Choose a valid hosting player.');
 const sessionId=runtime.id(),listeners=new Set<()=>void>();let sequence=0,closed=false,error:string|null=null;
 type Peer={transport:PeerTransport;playerId:string|null;pending:PendingClaim|null;seen:Set<string>;claimIds:Set<string>;tokens:number;at:number;unsubscribe:()=>void};
 const peers=new Map<string,Peer>();
 const online=()=>[localPlayerId,...[...peers.values()].flatMap(p=>p.playerId?[p.playerId]:[])];
 const lobby=():Lobby=>({sessionId,gameId:game.id,gameName:game.name,players:game.players.map(p=>({...p,online:online().includes(p.id)}))});
 const notify=()=>{for(const fn of listeners)fn();};
 function drop(peer:Peer){if(!peers.delete(peer.transport.id))return;peer.unsubscribe();peer.pending=null;peer.playerId=null;peer.transport.close();broadcast();}
 function send(peer:Peer,message:Message){try{peer.transport.send(message);}catch{error='A connection could not receive state. Please reconnect that player.';drop(peer);}}
 function broadcast(){sequence++;for(const peer of peers.values()){if(peer.transport.state!=='open')continue;send(peer,{type:'lobby',lobby:lobby()});if(peer.playerId)send(peer,{type:'snapshot',snapshot:{sessionId,sequence,game,onlinePlayerIds:online()}});}notify();}
 const controller:HostSession={
 getView:():SessionView=>structuredClone({mode:'host',phase:closed?'closed':'ready',game,lobby:lobby(),localPlayerId,onlinePlayerIds:closed?[]:online(),pendingClaims:[...peers.values()].flatMap(p=>p.pending?[p.pending]:[]),error}),
 subscribe(fn){listeners.add(fn);return ()=>{listeners.delete(fn);};},
 roll(sides:DieSides){if(closed)return;try{game=recordRoll(game,localPlayerId,sides,runtime);error=null;broadcast();}catch(e){error=(e as Error).message;notify();}},
 attach(transport){
   if(closed||peers.has(transport.id)||peers.size>=31||[...peers.values()].filter(p=>!p.playerId).length>=8){transport.close();return;}
   if(transport.state==='closed'||transport.state==='failed'){transport.close();return;}
   const peer:Peer={transport,playerId:null,pending:null,seen:new Set(),claimIds:new Set(),tokens:20,at:Date.now(),unsubscribe:()=>{}};peers.set(transport.id,peer);
   peer.unsubscribe=transport.subscribe(event=>{
     if(closed||!peers.has(transport.id))return;
     if(event.type==='state'){if(event.state==='open')send(peer,{type:'hello',version:1});else if(['disconnected','failed','closed'].includes(event.state))drop(peer);return;}
     if(event.type!=='message')return;
     peer.tokens=Math.min(20,peer.tokens+Math.max(0,Date.now()-peer.at)/100);peer.at=Date.now();if(peer.tokens<1){drop(peer);return;}peer.tokens--;
     try {
       const message=parseMessage(event.value);
       if(message.type==='hello'){send(peer,{type:'lobby',lobby:lobby()});return;}
       if(message.type==='claim'){
         check(!peer.playerId,'This connection already has a player.');if(peer.claimIds.has(message.requestId))return;check(peer.claimIds.size<4096,'Claim history is full. Reconnect with a fresh invitation.');peer.claimIds.add(message.requestId);peer.pending={peerId:transport.id,requestId:message.requestId,claim:message.claim};notify();return;
       }
       if(message.type==='roll-request'){
         check(peer.playerId,'Host approval is required before rolling.');if(peer.seen.has(message.requestId))return;
         check(peer.seen.size<4096,'Request history is full. Reconnect using a fresh invitation to roll again.');
         game=recordRoll(game,peer.playerId,message.sides,runtime);peer.seen.add(message.requestId);broadcast();return;
       }
       throw new Error('Guests cannot send host state or administrative actions.');
     }catch(e){send(peer,{type:'error',message:(e as Error).message.slice(0,300)});}
   });
   if(transport.state==='open')send(peer,{type:'hello',version:1});
 },
 approve(peerId,requestId){
   const peer=peers.get(peerId),pending=peer?.pending;if(closed||!peer||!pending||pending.requestId!==requestId)return;
   try {
     check(!peer.playerId&&peer.transport.state==='open','Player is no longer connected.');const claim=pending.claim;let playerId:string;
     if('playerId'in claim){check(game.players.some(p=>p.id===claim.playerId)&&!online().includes(claim.playerId),'That player is already occupied or unavailable.');playerId=claim.playerId;}
     else {const added=addPlayer(game,claim.newPlayer.name,claim.newPlayer.role,runtime);game=added.game;playerId=added.player.id;}
     peer.playerId=playerId;peer.pending=null;send(peer,{type:'claim-result',requestId,status:'approved',playerId});broadcast();
   }catch(e){peer.pending=null;send(peer,{type:'claim-result',requestId,status:'rejected',reason:(e as Error).message});notify();}
 },
 reject(peerId,requestId){const peer=peers.get(peerId);if(peer?.pending?.requestId!==requestId)return;peer.pending=null;send(peer,{type:'claim-result',requestId,status:'rejected',reason:'The host declined this request. Choose another player or name and try again.'});notify();},
 close(){if(closed)return;closed=true;for(const peer of peers.values()){peer.unsubscribe();peer.transport.close();}peers.clear();notify();listeners.clear();}
 };
 return controller;
}
