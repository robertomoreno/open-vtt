import { dice,type DieSides } from '../game/types';
import type { SessionView } from '../session/types';
import { el,button,field,option,status } from './dom';
export type RoomActions={roll(sides:DieSides):void;download():void;leave():void;invite():void;approve(peerId:string,requestId:string):void;reject(peerId:string,requestId:string):void};
export type RoomView={update(data:SessionView):void;destroy():void};
export function createRoomView(root:HTMLElement,initial:SessionView,actions:RoomActions):RoomView {
 const title=el('h1'),identity=el('p','','lead'),snapshotLabel=el('p','','muted'),roster=el('ul','','roster'),rolls=el('ol','','rolls');rolls.setAttribute('aria-label','Roll history');const pending=el('section'),message=status(),claimRows=new Map<string,HTMLElement>();
 const die=field('Die','die','select');die.input.append(...dice.map(n=>option(String(n),`d${n}`)));die.input.value='20';const roll=button('Roll the dice ↗',()=>actions.roll(Number(die.input.value) as DieSides),'roll');roll.className='primary';
 const invite=button('＋ Invite a player',actions.invite,'invite'),download=button('Download game JSON',actions.download,'download');const left=el('aside','','panel'),right=el('section','','panel');left.append(el('h2','Around the table'),roster,invite,el('p','Players connect directly. Keep the host tab open.','muted'));right.append(el('h2','The dice have a story.'),el('p','One roll. Seen by everyone at the table.','muted'),rolls,die.wrapper,roll);
 const grid=el('div','','room');grid.append(left,right);root.replaceChildren(el('p','Your party’s shared space','eyebrow'),title,identity,snapshotLabel,message,grid,pending,download,button('Leave table',actions.leave,'leave'));
 function update(view:SessionView){const game=view.game;title.textContent=game?.name??'Joining the table';const local=game?.players.find(p=>p.id===view.localPlayerId);identity.textContent=`${view.mode==='host'?'Host':'Guest'}${local?` · ${local.name} · ${local.role.toUpperCase()}`:''} · ${view.phase}`;message.textContent=view.error??'';roll.disabled=view.phase!=='ready';invite.hidden=view.mode!=='host';download.disabled=!game;
   snapshotLabel.textContent=view.mode==='guest'?'Last received state — may differ from the host after connection loss.':'';
   roster.replaceChildren(...(game?.players??[]).map(p=>el('li',`${p.name}${p.id===view.localPlayerId?' (you)':''} · ${p.role.toUpperCase()} · ${view.onlinePlayerIds.includes(p.id)?'Online':'Offline'}`)));
   rolls.replaceChildren(...(game?.rolls??[]).slice().reverse().map(r=>{const row=el('li','','roll');row.dataset.roll=r.id;row.append(el('strong',String(r.value),'die'),el('span',`${game!.players.find(p=>p.id===r.playerId)!.name} rolled a d${r.sides}`),el('small',new Date(r.at).toLocaleTimeString()));return row;}));
   if(!game?.rolls.length)rolls.append(el('li','A quiet table. Make the first roll.','muted'));
   const activeClaims=new Set<string>();
   for(const p of view.pendingClaims){
     const key=JSON.stringify([p.peerId,p.requestId]);activeClaims.add(key);let row=claimRows.get(key);
     if(!row){row=el('article','','save');row.append(el('span'),button('Approve',()=>actions.approve(p.peerId,p.requestId)),button('Reject',()=>actions.reject(p.peerId,p.requestId)));claimRows.set(key,row);pending.append(row);}
     const claim=p.claim,name='playerId'in claim?game?.players.find(player=>player.id===claim.playerId)?.name:`${claim.newPlayer.name} · ${claim.newPlayer.role.toUpperCase()}`;
     row.firstElementChild!.textContent=`${name??'Unknown player'} requests to join`;
   }
   for(const [key,row]of claimRows)if(!activeClaims.has(key)){row.remove();claimRows.delete(key);}
 }update(initial);return {update,destroy(){root.replaceChildren();}};
}
