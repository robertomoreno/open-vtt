import { check,object,id,text,role,sides,integer,validateGame,validatePlayer } from '../game/validation';
import type { DieSides } from '../game/types';
import type { Claim,Lobby,Snapshot } from './types';
export type Message={type:'hello';version:1}|{type:'lobby';lobby:Lobby}|{type:'claim';requestId:string;claim:Claim}|{type:'claim-result';requestId:string;status:'approved'|'rejected';playerId?:string;reason?:string}|{type:'roll-request';requestId:string;sides:DieSides}|{type:'snapshot';snapshot:Snapshot}|{type:'error';message:string};
export function parseClaim(value:unknown):Claim {
 const c=object(value,['playerId','newPlayer']);check(Object.keys(c).length===1,'Choose one player identity.');
 if('playerId'in c)return {playerId:id(c.playerId)};
 const p=object(c.newPlayer,['name','role']);return {newPlayer:{name:text(p.name),role:role(p.role)}};
}
function parseLobby(value:unknown):Lobby {
 const l=object(value,['sessionId','gameId','gameName','players']);check(Array.isArray(l.players)&&l.players.length>=1&&l.players.length<=32,'Invalid roster.');
 const players=l.players.map(value=>{const p=object(value,['id','name','role','online']);check(typeof p.online==='boolean','Invalid presence.');return {...validatePlayer({id:p.id,name:p.name,role:p.role}),online:p.online};});
 check(new Set(players.map(p=>p.id)).size===players.length&&new Set(players.map(p=>p.name.toLowerCase())).size===players.length,'Duplicate roster identity.');
 return {sessionId:id(l.sessionId),gameId:id(l.gameId),gameName:text(l.gameName,100),players};
}
export function parseMessage(value:unknown):Message {
 const raw=object(value,['type','version','lobby','requestId','claim','status','playerId','reason','sides','snapshot','message']);
 switch(raw.type){
 case 'hello':object(raw,['type','version']);check(raw.version===1,'Unsupported session version.');return {type:'hello',version:1};
 case 'lobby':object(raw,['type','lobby']);return {type:'lobby',lobby:parseLobby(raw.lobby)};
 case 'claim':object(raw,['type','requestId','claim']);return {type:'claim',requestId:id(raw.requestId),claim:parseClaim(raw.claim)};
 case 'claim-result':object(raw,['type','requestId','status','playerId','reason']);check(raw.status==='approved'||raw.status==='rejected','Invalid claim status.');check(raw.status!=='approved'||typeof raw.playerId==='string','Missing approved player.');return {type:'claim-result',requestId:id(raw.requestId),status:raw.status,...(raw.playerId!==undefined?{playerId:id(raw.playerId)}:{}),...(raw.reason!==undefined?{reason:text(raw.reason,300)}:{})};
 case 'roll-request':object(raw,['type','requestId','sides']);return {type:'roll-request',requestId:id(raw.requestId),sides:sides(raw.sides)};
 case 'snapshot':{
   object(raw,['type','snapshot']);const s=object(raw.snapshot,['sessionId','sequence','game','onlinePlayerIds']);const game=validateGame(s.game);check(Array.isArray(s.onlinePlayerIds)&&s.onlinePlayerIds.length<=32,'Invalid presence list.');const online=s.onlinePlayerIds.map(id);check(new Set(online).size===online.length&&online.every(pid=>game.players.some(p=>p.id===pid)),'Invalid presence reference.');return {type:'snapshot',snapshot:{sessionId:id(s.sessionId),sequence:integer(s.sequence),game,onlinePlayerIds:online}};
 }
 case 'error':object(raw,['type','message']);return {type:'error',message:text(raw.message,300)};
 default:throw new Error('Unsupported session message.');
 }
}
