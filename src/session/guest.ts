import type { Runtime } from '../game/types';
import type { PeerTransport } from '../network/peer';
import type { GuestSession,SessionView } from './types';
import { parseClaim,parseMessage } from './messages';
export function createGuestSession(transport:PeerTransport,runtime:Runtime):GuestSession {
 let view:SessionView={mode:'guest',phase:'lobby',game:null,lobby:null,localPlayerId:null,onlinePlayerIds:[],pendingClaims:[],error:null};
 let requestId:string|null=null,sequence=-1,closed=false;const listeners=new Set<()=>void>();
 const notify=()=>{for(const fn of listeners)fn();};
 function send(value:unknown){try{transport.send(value);}catch(e){view.error=(e as Error).message;notify();}}
 const unsubscribe=transport.subscribe(event=>{
   if(closed)return;
   if(event.type==='error'){view.error=event.message;notify();return;}
   if(event.type==='state'){
     if(event.state==='open'){if(view.phase==='disconnected')view.phase=view.game?'ready':'lobby';send({type:'hello',version:1});}
     else if(event.state==='closed'||event.state==='failed'||event.state==='disconnected'){view.phase='disconnected';view.onlinePlayerIds=[];view.error='Host connection lost. Export your last received state, then use a fresh invitation to reconnect.';}
     notify();return;
   }
   try {
     const message=parseMessage(event.value);
     if(message.type==='hello'){send({type:'hello',version:1});return;}
     if(message.type==='lobby'){
       if(view.lobby&&(message.lobby.sessionId!==view.lobby.sessionId||message.lobby.gameId!==view.lobby.gameId))return;
       view.lobby=message.lobby;
     } else if(message.type==='claim-result'){
       if(message.requestId!==requestId)return;
       if(message.status==='approved'){view.localPlayerId=message.playerId!;view.error=null;}else {view.phase='lobby';view.error=message.reason??'Request declined.';}
       requestId=null;
     } else if(message.type==='snapshot'){
       const s=message.snapshot;
       if(!view.localPlayerId||!view.lobby||s.sessionId!==view.lobby.sessionId||s.game.id!==view.lobby.gameId||s.sequence<=sequence||s.game.revision<(view.game?.revision??0)||!s.game.players.some(p=>p.id===view.localPlayerId))return;
       sequence=s.sequence;view.game=s.game;view.onlinePlayerIds=s.onlinePlayerIds;view.phase=transport.state==='open'?'ready':'disconnected';
     }else if(message.type==='error')view.error=message.message;
     else throw new Error('Unexpected guest-side message from host.');
     notify();
   }catch(e){view.error=(e as Error).message;notify();}
 });
 const controller:GuestSession={getView:()=>structuredClone(view),subscribe(fn){listeners.add(fn);return ()=>{listeners.delete(fn);};},
 claim(value){if(closed||view.phase!=='lobby'||!view.lobby)return;try{const claim=parseClaim(value);requestId=runtime.id();view.phase='claiming';view.error=null;send({type:'claim',requestId,claim});notify();}catch(e){view.error=(e as Error).message;notify();}},
 roll(sides){if(!closed&&view.phase==='ready'&&transport.state==='open')send({type:'roll-request',requestId:runtime.id(),sides});},
 close(){if(closed)return;closed=true;unsubscribe();transport.close();view.phase='closed';view.onlinePlayerIds=[];notify();listeners.clear();}
 };
 if(transport.state==='open')send({type:'hello',version:1});return controller;
}
