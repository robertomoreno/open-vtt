import type { Game,Player,Role,DieSides } from '../game/types';
import type { PeerTransport } from '../network/peer';
export type Claim={playerId:string}|{newPlayer:{name:string;role:Role}};
export type Lobby={sessionId:string;gameId:string;gameName:string;players:Array<Player & {online:boolean}>};
export type PendingClaim={peerId:string;requestId:string;claim:Claim};
export type Snapshot={sessionId:string;sequence:number;game:Game;onlinePlayerIds:string[]};
export type SessionView={mode:'host'|'guest';phase:'lobby'|'claiming'|'ready'|'disconnected'|'closed';game:Game|null;lobby:Lobby|null;localPlayerId:string|null;onlinePlayerIds:string[];pendingClaims:PendingClaim[];error:string|null};
export interface SessionController {getView():SessionView;subscribe(listener:()=>void):()=>void;roll(sides:DieSides):void;close():void;}
export interface HostSession extends SessionController {attach(transport:PeerTransport):void;approve(peerId:string,requestId:string):void;reject(peerId:string,requestId:string):void;}
export interface GuestSession extends SessionController {claim(value:Claim):void;}
