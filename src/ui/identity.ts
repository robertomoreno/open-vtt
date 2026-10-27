import type { Lobby,Claim } from '../session/types';
import { el,button,field,option } from './dom';
export type IdentityActions={claim(value:Claim):void};
export type IdentityView={update(lobby:Lobby):void;destroy():void};
export function createIdentityView(root:HTMLElement,initial:Lobby,rememberedPlayerId:string|null,actions:IdentityActions):IdentityView {
 const title=el('h1','Who’s joining the story?'),players=field('Available saved player','claim-player','select'),existing=button('Request saved player',()=>{if(players.input.value)actions.claim({playerId:players.input.value});},'claim-existing'),saved=el('article','','panel');saved.append(el('h2','A familiar face'),players.wrapper,existing,el('p','A remembered choice is a convenience, not proof of identity. The host approves every claim.','muted'));
 const fresh=el('form','','panel'),name=field('Player name','claim-name'),role=field('Role','claim-role','select');(name.input as HTMLInputElement).required=true;role.input.append(option('pj','PJ · Player'),option('gm','GM · Game master'));const submit=button('Request new player',()=>{},'claim-new');submit.type='submit';fresh.append(el('h2','A new face'),name.wrapper,role.wrapper,submit,el('p','Roles label players; they do not grant host authority.','muted'));fresh.onsubmit=e=>{e.preventDefault();actions.claim({newPlayer:{name:name.input.value,role:role.input.value as 'gm'|'pj'}});};const grid=el('div','','grid');grid.append(saved,fresh);root.replaceChildren(el('p',initial.gameName,'eyebrow'),title,grid);
 let first=true;
 function update(lobby:Lobby){const selected=first?rememberedPlayerId:players.input.value;first=false;players.input.replaceChildren(...lobby.players.map(p=>{const o=option(p.id,`${p.name} · ${p.role.toUpperCase()} · ${p.online?'Occupied':'Available'}`);o.disabled=p.online;return o;}));const available=lobby.players.filter(p=>!p.online);players.input.value=available.some(p=>p.id===selected)?selected!:available[0]?.id??'';existing.disabled=!available.length;}
 update(initial);return {update,destroy(){root.replaceChildren();}};
}
