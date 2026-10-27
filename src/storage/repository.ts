import type { Game } from '../game/types';
import { validateGame } from '../game/validation';
export type SaveResult = {ok:true} | {ok:false;message:string};
export type GameRepository = ReturnType<typeof createRepository>;
const prefix='gather:game:';
const warning='Browser save unavailable. Your game is still in memory; download a JSON copy to keep it.';
export function createRepository(storage: Storage) {
  function write(key:string,value:string):SaveResult { try {storage.setItem(key,value);return {ok:true};} catch {return {ok:false,message:warning};} }
  return {
    list(): {games:Game[];warnings:string[]} {
      const games:Game[]=[], warnings:string[]=[];
      try { for(let n=0;n<storage.length;n++) { const key=storage.key(n); if(!key?.startsWith(prefix))continue;
        try { const game=validateGame(JSON.parse(storage.getItem(key)!)); if(key!==prefix+game.id)throw new Error(); games.push(game); }
        catch {warnings.push('A corrupt browser save was skipped. Other saves are still available.');}
      } } catch {warnings.push(warning);}
      return {games:games.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),warnings};
    },
    get(id:string):Game|null {try {const raw=storage.getItem(prefix+id); if(!raw)return null;const game=validateGame(JSON.parse(raw));return game.id===id?game:null;}catch{return null;}},
    save(game:Game):SaveResult {try {return write(prefix+game.id,JSON.stringify(validateGame(game)));}catch{return {ok:false,message:'Invalid game; existing browser saves were not changed.'};}},
    rememberPlayer(gameId:string,playerId:string):SaveResult {return write('gather:identity:'+gameId,playerId);},
    rememberedPlayer(gameId:string):string|null {try{return storage.getItem('gather:identity:'+gameId);}catch{return null;}}
  };
}
export function browserRepository():GameRepository {
  try {return createRepository(window.localStorage);} catch {
    return createRepository(new Proxy({} as Storage,{get(){throw new Error('Storage denied');}}));
  }
}
