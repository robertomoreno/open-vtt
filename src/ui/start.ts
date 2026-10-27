import type { Game } from '../game/types';
import { el,button,field } from './dom';
export type StartData={games:Game[];warnings:string[];canCreate:boolean;canConnect:boolean};
export type StartActions={create(name:string,creator:string):void;restore(game:Game):void;import(file:File):void;join(code:string):void};
export function createStartView(root:HTMLElement,data:StartData,actions:StartActions) {
 root.replaceChildren();root.append(el('p','Your table. Your stories.','eyebrow'),el('h1','Every adventure starts here.'),el('p','Start something new or pick up where you left off. Your games stay in your browser, not on someone else’s server.','lead'));
 const grid=el('div','','grid'),fresh=el('form','','panel');fresh.id='new-game';fresh.append(el('span','＋','icon'),el('h2','A fresh beginning'),el('p','Create a game. Invite your party when you’re ready.'));
 const name=field('Game name','game-name'),creator=field('Your name','creator-name');for(const f of [name,creator]){(f.input as HTMLInputElement).required=true;fresh.append(f.wrapper);}
 const create=button('Create game →',()=>{},'create-game');create.type='submit';create.className='primary';fresh.append(create);fresh.onsubmit=e=>{e.preventDefault();actions.create(name.input.value,creator.input.value);};
 const saved=el('article','','panel');saved.append(el('span','↥','icon'),el('h2','An unfinished story'),el('p','Open a JSON game file, including its players and recent rolls.'));
 const file=field('Load state file (.json)','import-file');const input=file.input as HTMLInputElement;input.type='file';input.accept='.json,application/json';input.onchange=()=>{const f=input.files?.[0];if(f)actions.import(f);input.value='';};saved.append(file.wrapper,el('p','Loading starts a new live session. Players reconnect and reclaim their names.','muted'));
 grid.append(fresh,saved);const saves=el('section','','saves');saves.setAttribute('aria-label','Saved in this browser');const join=el('form','','panel');const code=field('Invitation link or code','join-code','textarea');const joinButton=button('Open invitation',()=>{},'open-invitation');joinButton.type='submit';join.append(el('h2','Have an invitation?'),code.wrapper,joinButton);join.onsubmit=e=>{e.preventDefault();actions.join(code.input.value);};root.append(grid,saves,join);
 function update(next:StartData){create.disabled=!next.canCreate;joinButton.disabled=!next.canConnect;saves.replaceChildren(el('h2','Saved in this browser'));
  for(const warning of next.warnings)saves.append(el('p',warning,'notice'));
  for(const game of next.games){const row=el('article','','save');const copy=el('div');copy.append(el('strong',game.name),el('p',`${game.players.length} players · ${game.rolls.length} recent rolls`,'muted'));const open=button('Continue →',()=>actions.restore(game));open.dataset.game=game.id;row.append(copy,open);saves.append(row);}
  if(!next.games.length)saves.append(el('p','No games saved here yet.','muted'));
 }update(data);return {update,destroy(){root.replaceChildren();}};
}
