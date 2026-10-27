import type { Game, Role, Runtime, DieSides } from './types';
import { validateGame, check, sides as validateSides } from './validation';
export function createGame(name: string, creatorName: string, runtime: Runtime): Game {
  const at=runtime.now(); return validateGame({schemaVersion:1,id:runtime.id(),name,createdAt:at,updatedAt:at,revision:0,players:[{id:runtime.id(),name:creatorName,role:'gm'}],rolls:[]});
}
export function addPlayer(game: Game, name: string, role: Role, runtime: Runtime) {
  const now=runtime.now(),at=now<game.updatedAt?game.updatedAt:now;
  const next=validateGame({...game,updatedAt:at,revision:game.revision+1,players:[...game.players,{id:runtime.id(),name,role}]});
  return {game:next,player:next.players[next.players.length-1]};
}
export function recordRoll(game: Game, playerId: string, sides: DieSides, runtime: Runtime): Game {
  check(game.players.some(p=>p.id===playerId),'Unknown player.'); validateSides(sides);
  const now=runtime.now(),at=now<game.updatedAt?game.updatedAt:now;
  return validateGame({...game,updatedAt:at,revision:game.revision+1,rolls:[...game.rolls,{id:runtime.id(),playerId,sides,value:runtime.die(sides),at}].slice(-100)});
}
