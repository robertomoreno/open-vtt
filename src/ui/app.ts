import type { Game,Runtime } from '../game/types';
import { createGame,addPlayer } from '../game/model';
import { browserRuntime } from '../game/random';
import { browserRepository,type GameRepository } from '../storage/repository';
import { parseGameFile,downloadGame } from '../storage/files';
import { createHostSession } from '../session/host';
import type { SessionController,HostSession } from '../session/types';
import { createStartView } from './start';
import { createRestoreView } from './restore';
import { createRoomView } from './room';
import { el,status } from './dom';
export type Environment={canCreate:boolean;canConnect:boolean;message:string};
export function detectEnvironment():Environment {
 const cryptoAvailable=typeof crypto!=='undefined'&&typeof crypto.randomUUID==='function'&&typeof crypto.getRandomValues==='function',textAvailable=typeof TextEncoder!=='undefined'&&typeof TextDecoder!=='undefined';
 const secure=globalThis.isSecureContext!==false;const canCreate=cryptoAvailable&&textAvailable&&secure,canConnect=canCreate&&typeof RTCPeerConnection!=='undefined';
 return {canCreate,canConnect,message:!canCreate?'Use HTTPS or localhost in a modern browser with Web Crypto and TextEncoder/TextDecoder.':!canConnect?'WebRTC is unavailable. Use a current desktop browser over HTTPS or localhost to connect; local games still work.':''};
}
export type AppDependencies={repository?:GameRepository;runtime?:Runtime;parseFile?:(file:File)=>Promise<Game>;download?:(game:Game)=>void;confirm?:(message:string)=>boolean;environment?:Environment};
const mounts=new WeakMap<HTMLElement,{destroy():void}>();
export function mountApp(root:HTMLElement,deps:AppDependencies={}) {
 mounts.get(root)?.destroy();const repository=deps.repository??browserRepository(),runtime=deps.runtime??browserRuntime,environment=deps.environment??detectEnvironment();
 const header=el('header'),brand=el('div','Gather','brand');header.append(brand,el('span','A small place for big adventures','eyebrow'));const warning=status(),error=status(),screen=el('div','','screen'),flow=el('section');flow.id='connection-flow';root.replaceChildren(header,warning,error,screen,flow);
 let session:SessionController|null=null,view:{destroy():void}|null=null,unsubscribe=()=>{},destroyed=false,lastSaved='',saveFailed=false;
 const report=(e:unknown)=>{error.textContent=e instanceof Error?e.message:String(e);};
 function persist(){const state=session!.getView();if(state.game&&`${state.game.id}:${state.game.revision}`!==lastSaved){lastSaved=`${state.game.id}:${state.game.revision}`;const result=repository.save(state.game);saveFailed=!result.ok;warning.textContent=result.ok?'Saved in this browser. Download a copy for safekeeping.':result.message;}
   if(state.game&&state.localPlayerId&&state.phase==='ready'){const result=repository.rememberPlayer(state.game.id,state.localPlayerId);if(!result.ok)warning.textContent=result.message;}
 }
 function clearSession(){unsubscribe();unsubscribe=()=>{};session?.close();session=null;lastSaved='';}
 function showStart(){view?.destroy();const data=repository.list();view=createStartView(screen,{...data,...environment},{create(name,creator){try{if(!environment.canCreate)throw new Error(environment.message);const game=createGame(name,creator,runtime);openHost(game,game.players[0].id);}catch(e){report(e);}},restore:game=>restore(game,false),async import(file){try{const game=await(deps.parseFile??parseGameFile)(file);if(!destroyed)restore(game,true);}catch(e){if(!destroyed)report(e);}},join:()=>report(new Error('Connection controls are not available yet.'))});warning.textContent=environment.message;}
 function restore(game:Game,imported:boolean){view?.destroy();view=createRestoreView(screen,{game,rememberedPlayerId:repository.rememberedPlayer(game.id),replace:imported&&repository.get(game.id)!==null},{open(playerId,newName){try{if(!environment.canCreate)throw new Error(environment.message);if(!playerId){const added=addPlayer(game,newName,'gm',runtime);openHost(added.game,added.player.id);}else openHost(game,playerId);}catch(e){report(e);}},cancel:showStart});}
 function openHost(game:Game,playerId:string){const host=createHostSession(game,playerId,runtime);clearSession();session=host;view?.destroy();const room=createRoomView(screen,host.getView(),{roll:sides=>host.roll(sides),download:()=>{try{(deps.download??downloadGame)(host.getView().game!);}catch(e){report(e);}},leave(){if(saveFailed&&!(deps.confirm??window.confirm)('This game has not been saved. Download a JSON copy before leaving. Leave anyway?'))return;clearSession();showStart();},invite:()=>report(new Error('Connection controls are not available yet.')),approve:(p,r)=>host.approve(p,r),reject:(p,r)=>host.reject(p,r)});view=room;unsubscribe=host.subscribe(()=>{persist();room.update(host.getView());});persist();error.textContent='';}
 const beforeUnload=(event:BeforeUnloadEvent)=>{if(saveFailed&&session){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',beforeUnload);
 const app={destroy(){if(destroyed)return;destroyed=true;window.removeEventListener('beforeunload',beforeUnload);clearSession();view?.destroy();root.replaceChildren();mounts.delete(root);}};mounts.set(root,app);showStart();return app;
}
