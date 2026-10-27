import { dice, type Game, type Player, type Roll, type Role, type DieSides } from './types';
export class ValidationError extends Error {}
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ValidationError(message);
}
export function object(value: unknown, fields: string[]): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected an object.');
  check(Object.keys(value).every(key => fields.includes(key)), 'Unexpected fields.');
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 64): string {
  check(typeof value === 'string' && value.trim().length > 0 && [...value].length <= max, `Text must contain 1–${max} characters.`);
  return value.trim();
}
export function id(value: unknown): string { const result = text(value); check(result === value, 'Invalid ID.'); return result; }
export function role(value: unknown): Role { check(value === 'gm' || value === 'pj', 'Invalid role.'); return value; }
export function sides(value: unknown): DieSides { check(dice.includes(value as DieSides), 'Choose a supported die.'); return value as DieSides; }
export function integer(value: unknown, min = 0): number { check(Number.isSafeInteger(value) && (value as number) >= min, 'Invalid integer.'); return value as number; }
function timestamp(value: unknown): string {
  check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'Invalid timestamp.'); return value;
}
export function validatePlayer(value: unknown): Player { const p=object(value,['id','name','role']); return {id:id(p.id),name:text(p.name),role:role(p.role)}; }
export function validateGame(value: unknown): Game {
  const g=object(value,['schemaVersion','id','name','createdAt','updatedAt','revision','players','rolls']);
  check(g.schemaVersion === 1,'Unsupported game schema version.');
  check(Array.isArray(g.players) && g.players.length >= 1 && g.players.length <= 32,'Games need 1–32 players.');
  check(Array.isArray(g.rolls) && g.rolls.length <= 100,'At most 100 rolls are supported.');
  const players=g.players.map(validatePlayer);
  check(new Set(players.map(p=>p.id)).size===players.length && new Set(players.map(p=>p.name.toLowerCase())).size===players.length,'Duplicate player ID or name.');
  const rolls: Roll[]=g.rolls.map(value=>{
    const r=object(value,['id','playerId','sides','value','at']); const die=sides(r.sides); const result=integer(r.value,1);
    check(result<=die && players.some(p=>p.id===r.playerId),'Invalid die result or player reference.');
    return {id:id(r.id),playerId:id(r.playerId),sides:die,value:result,at:timestamp(r.at)};
  });
  check(new Set(rolls.map(r=>r.id)).size===rolls.length,'Duplicate roll ID.');
  const createdAt=timestamp(g.createdAt), updatedAt=timestamp(g.updatedAt);
  check(updatedAt>=createdAt,'Updated time precedes creation.');
  return {schemaVersion:1,id:id(g.id),name:text(g.name,100),createdAt,updatedAt,revision:integer(g.revision),players,rolls};
}
