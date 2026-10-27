import type { Game } from '../game/types';
import { check, validateGame } from '../game/validation';
export function serializeGame(game:Game):string {return JSON.stringify(validateGame(game),null,2);}
export async function parseGameFile(file:File):Promise<Game> {
  check(file.size<=1024*1024,'Game files must be at most 1 MiB.');
  let value:unknown; try { value=JSON.parse(await file.text()); } catch {throw new Error('This is not a readable JSON game file.');}
  return validateGame(value);
}
export function downloadGame(game:Game):void {
  const url=URL.createObjectURL(new Blob([serializeGame(game)],{type:'application/json'}));
  const anchor=document.createElement('a'); anchor.href=url; anchor.download=`gather-${game.id}.json`;
  document.body.append(anchor);
  try {anchor.click();} finally {anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
}
