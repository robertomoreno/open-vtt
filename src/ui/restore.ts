import type { Game } from '../game/types';
import { el,button,field,option } from './dom';
export type RestoreData={game:Game;rememberedPlayerId:string|null;replace:boolean};
export type RestoreActions={open(playerId:string|null,newGMName:string):void;cancel():void};
export function createRestoreView(root:HTMLElement,data:RestoreData,actions:RestoreActions){
 root.replaceChildren(el('p','A new session, a familiar story.','eyebrow'),el('h1',data.game.name));const form=el('form','','panel');form.append(el('p',`${data.game.players.length} players · ${data.game.rolls.length} recent rolls. No old connections will be restored.`));
 if(data.replace)form.append(el('p','A game with this ID already exists. Opening this file replaces that browser save; cancel keeps it unchanged.','notice'));
 const player=field('Host as player','restore-player','select');player.input.append(...data.game.players.map(p=>option(p.id,`${p.name} · ${p.role.toUpperCase()}`)),option('new','Create a new GM'));player.input.value=data.game.players.some(p=>p.id===data.rememberedPlayerId)?data.rememberedPlayerId!:data.game.players[0].id;
 const name=field('New GM name (only for a new player)','restore-name');const open=button(data.replace?'Replace saved game and open':'Open game',()=>{});open.type='submit';open.className='primary';form.append(player.wrapper,name.wrapper,open,button('Cancel',actions.cancel,'cancel-restore'));form.onsubmit=e=>{e.preventDefault();actions.open(player.input.value==='new'?null:player.input.value,name.input.value);};root.append(form);
 return {update(_data:RestoreData){},destroy(){root.replaceChildren();}};
}
