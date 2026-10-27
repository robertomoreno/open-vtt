import { expect, it } from 'vitest';
import { createGame, addPlayer, recordRoll } from '../../src/game/model';
import { fixtureGame, runtime } from '../helpers/game';
it('creates an immutable game with one GM', () => {
  const game = createGame('  Lantern Road  ', ' Alex ', runtime());
  expect(game).toMatchObject({schemaVersion:1,name:'Lantern Road',revision:0,players:[{name:'Alex',role:'gm'}],rolls:[]});
  expect(game.players[0].id).not.toBe(game.id);
});
it('retains the latest 100 rolls and increments revision', () => {
  let game = fixtureGame(); const original = structuredClone(game); const rt = runtime();
  for(let n=0;n<101;n++) game = recordRoll(game,'alex',20,rt);
  expect(game.rolls).toHaveLength(100); expect(game.revision).toBe(101); expect(original.rolls).toEqual([]);
});
it('rejects duplicate names, unknown players, invalid dice/results and overflowing rosters', () => {
  const game = fixtureGame();
  expect(()=>addPlayer(game,'  aLeX ','pj',runtime())).toThrow();
  expect(()=>recordRoll(game,'missing',20,runtime())).toThrow();
  expect(()=>recordRoll(game,'alex',3 as 20,runtime())).toThrow();
  expect(()=>recordRoll(game,'alex',4,{...runtime(),die:()=>5})).toThrow();
  const full = {...game,players:Array.from({length:32},(_,n)=>({id:`p${n}`,name:`P${n}`,role:'pj' as const}))};
  expect(()=>addPlayer(full,'extra','pj',runtime())).toThrow();
});
it('keeps restored mutations usable and timestamps monotonic when the clock rolls back',()=>{
 const game={...fixtureGame(),updatedAt:'2026-10-27T12:05:00.000Z'},rt={...runtime(),now:()=> '2026-10-27T11:59:59.000Z'};
 const rolled=recordRoll(game,'alex',20,rt);expect(rolled.updatedAt).toBe('2026-10-27T12:05:00.000Z');expect(rolled.rolls[0].at).toBe('2026-10-27T12:05:00.000Z');expect(rolled.revision).toBe(1);
 const added=addPlayer(game,'Bea','pj',runtimeWithEarlierClock());expect(added.game.players).toHaveLength(2);expect(added.game.updatedAt).toBe('2026-10-27T12:05:00.000Z');
 function runtimeWithEarlierClock(){return {...runtime(),now:()=> '2026-10-27T11:59:59.000Z'};}
});
