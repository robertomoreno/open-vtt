import type { Game,Runtime } from '../game/types';
import { createGame,addPlayer } from '../game/model';
import { browserRuntime } from '../game/random';
import { browserRepository,type GameRepository } from '../storage/repository';
import { parseGameFile,downloadGame } from '../storage/files';
import { createHostSession } from '../session/host';
import { createGuestSession } from '../session/guest';
import type { SessionController,HostSession,GuestSession } from '../session/types';
import { createInvitation,answerInvitation,type PendingInvitation,type PeerTransport } from '../network/peer';
import { decodeSignal,signalLink,type Signal } from '../network/signaling';
import { createStartView } from './start';
import { createRestoreView } from './restore';
import { createRoomView,type RoomView } from './room';
import { createConnectionView,type ConnectionView,type ConnectionData } from './connection';
import { createIdentityView,type IdentityView } from './identity';
import { el,status } from './dom';

export type Environment={canCreate:boolean;canConnect:boolean;message:string};
export function detectEnvironment():Environment {
 const cryptoAvailable=typeof crypto!=='undefined'&&typeof crypto.randomUUID==='function'&&typeof crypto.getRandomValues==='function',textAvailable=typeof TextEncoder!=='undefined'&&typeof TextDecoder!=='undefined';
 const secure=globalThis.isSecureContext!==false;const canCreate=cryptoAvailable&&textAvailable&&secure,canConnect=canCreate&&typeof RTCPeerConnection!=='undefined';
 return {canCreate,canConnect,message:!canCreate?'Use HTTPS or localhost in a modern browser with Web Crypto and TextEncoder/TextDecoder.':!canConnect?'WebRTC is unavailable. Use a current desktop browser over HTTPS or localhost to connect; local games still work.':''};
}
export type AppDependencies={repository?:GameRepository;runtime?:Runtime;parseFile?:(file:File)=>Promise<Game>;download?:(game:Game)=>void;confirm?:(message:string)=>boolean;environment?:Environment;network?:{createInvitation?:typeof createInvitation;answerInvitation?:typeof answerInvitation}};
const mounts=new WeakMap<HTMLElement,{destroy():void}>();
export function mountApp(root:HTMLElement,deps:AppDependencies={}) {
 mounts.get(root)?.destroy();
 const repository=deps.repository??browserRepository(),runtime=deps.runtime??browserRuntime,environment=deps.environment??detectEnvironment();
 const header=el('header');header.append(el('div','Gather','brand'),el('span','A small place for big adventures','eyebrow'));
 const warning=status(),error=status(),screen=el('div','','screen'),flow=el('section');flow.id='connection-flow';root.replaceChildren(header,warning,error,screen,flow);
 let session:SessionController|null=null,view:{destroy():void}|null=null,room:RoomView|null=null,identity:IdentityView|null=null;
 let unsubscribe=()=>{},destroyed=false,lastSaved='',lastIdentity='',saveFailed=false,importGeneration=0;
 type Operation={kind:'host'|'guest';abort:AbortController;invitation?:PendingInvitation;transport?:PeerTransport;adopted?:boolean;unsubscribe:()=>void};
 let operation:Operation|null=null,connection:ConnectionView|null=null,connectionData:ConnectionData|null=null;
 const report=(e:unknown)=>{error.textContent=e instanceof Error?e.message:String(e);};
 const confirm=(message:string)=>(deps.confirm??window.confirm)(message);
 function showConnection(data:ConnectionData){connectionData=data;connection?.update(data);}
 function clearFlow(keepConnected=false){
   const old=operation;operation=null;old?.unsubscribe();
   if(old&&!(keepConnected&&old.adopted&&old.transport?.state==='open')){old.abort.abort();old.invitation?.cancel();old.transport?.close();}
   connection?.destroy();connection=null;connectionData=null;flow.replaceChildren();
 }
 function clearSession(){unsubscribe();unsubscribe=()=>{};session?.close();session=null;lastSaved='';lastIdentity='';room=null;identity=null;}
 function leave(){if(saveFailed&&!confirm('This game has not been saved. Download a JSON copy before leaving. Leave anyway?'))return;clearFlow();clearSession();showStart();}
 function persist(){
   const state=session!.getView();
   if(state.game&&`${state.game.id}:${state.game.revision}`!==lastSaved){lastSaved=`${state.game.id}:${state.game.revision}`;const result=repository.save(state.game);saveFailed=!result.ok;warning.textContent=result.ok?'Saved in this browser. Download a copy for safekeeping.':result.message;}
   if(state.game&&state.localPlayerId&&state.phase==='ready'&&lastIdentity!==`${state.game.id}:${state.localPlayerId}`){lastIdentity=`${state.game.id}:${state.localPlayerId}`;const result=repository.rememberPlayer(state.game.id,state.localPlayerId);if(!result.ok)warning.textContent=result.message;}
 }
 function download(){const game=session?.getView().game;if(game)try{(deps.download??downloadGame)(game);}catch(e){report(e);}}
 function renderSession(){
   if(!session)return;const state=session.getView();persist();
   if(state.mode==='guest'&&!state.game){
     if(state.lobby){
       if(!identity){view?.destroy();identity=createIdentityView(screen,state.lobby,repository.rememberedPlayer(state.lobby.gameId),{claim:value=>(session as GuestSession).claim(value)});view=identity;}
       else identity.update(state.lobby);
       const waiting=state.phase==='claiming';for(const button of screen.querySelectorAll<HTMLButtonElement>('button'))button.disabled=waiting||state.phase==='disconnected';
       error.textContent=state.error??(waiting?'Waiting for host approval.':'Connected. Choose a player; the host must approve.');
     }else {error.textContent=state.error??'Connecting to the host. Send the reply link to complete the exchange.';}
     return;
   }
   if(!room){view?.destroy();identity=null;room=createRoomView(screen,state,{roll:sides=>session?.roll(sides),download,leave,invite:startHostFlow,approve:(p,r)=>(session as HostSession).approve(p,r),reject:(p,r)=>(session as HostSession).reject(p,r)});view=room;}
   else room.update(state);
   const inviteButton=screen.querySelector<HTMLButtonElement>('#invite');if(inviteButton)inviteButton.disabled=!environment.canConnect;
   if(state.mode==='guest'&&state.phase==='ready'){clearFlow(true);error.textContent='';}
 }
 function openSession(next:SessionController){importGeneration++;clearSession();session=next;view?.destroy();view=null;room=null;identity=null;unsubscribe=next.subscribe(renderSession);renderSession();error.textContent='';}
 function openHost(game:Game,playerId:string){const next=createHostSession(game,playerId,runtime);clearFlow();openSession(next);}
 function showStart(){
   importGeneration++;view?.destroy();room=null;identity=null;const data=repository.list();
   view=createStartView(screen,{...data,...environment},{
     create(name,creator){try{if(!environment.canCreate)throw new Error(environment.message);const game=createGame(name,creator,runtime);openHost(game,game.players[0].id);}catch(e){report(e);}},
     restore:game=>restore(game,false),
     async import(file){const generation=++importGeneration;try{const game=await(deps.parseFile??parseGameFile)(file);if(!destroyed&&generation===importGeneration)restore(game,true);}catch(e){if(!destroyed&&generation===importGeneration)report(e);}},
     join:openCode
   });warning.textContent=environment.message;
 }
 function restore(game:Game,imported:boolean){
   importGeneration++;view?.destroy();view=createRestoreView(screen,{game,rememberedPlayerId:repository.rememberedPlayer(game.id),replace:imported&&repository.get(game.id)!==null},{
     open(playerId,newName){try{if(!environment.canCreate)throw new Error(environment.message);if(!playerId){const added=addPlayer(game,newName,'gm',runtime);openHost(added.game,added.player.id);}else openHost(game,playerId);}catch(e){report(e);}},cancel:showStart
   });
 }
 function monitor(op:Operation,transport:PeerTransport){
   op.transport=transport;
   const update=()=>{if(operation!==op||!connectionData)return;const state=transport.state;
     if(state==='open')showConnection({...connectionData,phase:'connected',message:'Connected. Player identity still requires host approval.'});
     else if(state==='closed'||state==='failed')showConnection({...connectionData,phase:'failed',message:'Connection closed or invitation expired. Generate a fresh invitation; restrictive networks may block direct connections.'});
   };
   op.unsubscribe=transport.subscribe(event=>{if(operation!==op||!connectionData)return;if(event.type==='error')showConnection({...connectionData,phase:'failed',message:event.message});else if(event.type==='state')update();});update();
 }
 function startHostFlow(){
   if(!environment.canConnect){report(new Error(environment.message));return;}if(session?.getView().mode!=='host')return;
   clearFlow(true);const op:Operation={kind:'host',abort:new AbortController(),unsubscribe:()=>{}};operation=op;
   connection=createConnectionView(flow,{
     async create(){
       if(operation!==op)return;op.invitation?.cancel();showConnection({kind:'host',phase:'generating',message:'Gathering network addresses. Please wait for complete ICE gathering…'});
       try {const pending=await(deps.network?.createInvitation??createInvitation)({signal:op.abort.signal});if(operation!==op){pending.cancel();return;}op.invitation=pending;showConnection({kind:'host',phase:'waiting',output:signalLink(pending.offer,location.href),message:'Awaiting reply. Share this invitation with one guest. It expires in 10 minutes; keep this tab open.'});monitor(op,pending.transport);}catch(e){if(operation===op)showConnection({kind:'host',phase:'failed',message:(e as Error).message});}
     },
     async accept(code){
       if(operation!==op||!op.invitation)return;
       try{const answer=decodeSignal(code);await op.invitation.accept(answer);if(operation!==op)return;(session as HostSession).attach(op.invitation.transport);op.adopted=true;showConnection({...connectionData!,phase:op.invitation.transport.state==='open'?'connected':'connecting',message:'Connecting directly to the player. Waiting for the data channel…'});}catch(e){if(operation===op){report(e);showConnection({...connectionData!,message:(e as Error).message});}}
     },
     cancel(){clearFlow(op.transport?.state==='open');}
   });showConnection({kind:'host',phase:'review',message:'One invitation per guest. Read the STUN/privacy notice, then create an invitation.'});flow.scrollIntoView?.({behavior:'smooth'});
 }
 function openCode(code:string){
   try {
     const signal=decodeSignal(code);
     if(signal.kind==='answer'){
       if(!operation?.invitation||operation.invitation.invitationId!==signal.invitationId)throw new Error('Reply expired or belongs to another host tab. Reloading loses pending invitations. Ask for a fresh invitation from the original host tab.');
       showConnection({...connectionData!,reply:code,message:'Reply loaded. Choose Connect player to apply it.'});return;
     }
     if(!environment.canConnect)throw new Error(environment.message);
     if(session&&!confirm('Leave the active game and open this invitation? Download unsaved state first.'))return;
     clearFlow();clearSession();showStart();const op:Operation={kind:'guest',abort:new AbortController(),unsubscribe:()=>{}};operation=op;
     connection=createConnectionView(flow,{async create(){
       if(operation!==op)return;showConnection({kind:'guest',phase:'generating',message:'Gathering network addresses to create your reply…'});
       try{const result=await(deps.network?.answerInvitation??answerInvitation)(signal,{signal:op.abort.signal});if(operation!==op){result.transport.close();return;}showConnection({kind:'guest',phase:'waiting',output:signalLink(result.reply,location.href),message:'Send this reply to your host. Keep this tab open while they paste it.'});monitor(op,result.transport);const guest=createGuestSession(result.transport,runtime);op.adopted=true;openSession(guest);}catch(e){if(operation===op)showConnection({kind:'guest',phase:'failed',message:(e as Error).message});}
     },accept:()=>{},cancel(){clearFlow();if(session?.getView().mode==='guest')clearSession();showStart();}});
     showConnection({kind:'guest',phase:'review',message:'Read the STUN/privacy notice. No network discovery starts until you choose Create reply.'});flow.scrollIntoView?.({behavior:'smooth'});
   }catch(e){report(e);}
 }
 function consumeHash(){if(!location.hash)return;const code=location.href;history.replaceState(null,'',location.pathname+location.search);openCode(code);}
 const beforeUnload=(event:BeforeUnloadEvent)=>{if(saveFailed&&session){event.preventDefault();event.returnValue='';}};
 window.addEventListener('beforeunload',beforeUnload);window.addEventListener('hashchange',consumeHash);
 const app={destroy(){if(destroyed)return;destroyed=true;importGeneration++;window.removeEventListener('beforeunload',beforeUnload);window.removeEventListener('hashchange',consumeHash);clearFlow();clearSession();view?.destroy();root.replaceChildren();mounts.delete(root);}};
 mounts.set(root,app);showStart();consumeHash();return app;
}
