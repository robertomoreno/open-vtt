import { expect, it } from 'vitest';
import { validateGame } from '../../src/game/validation';
import { fixtureGame } from '../helpers/game';
it('copies valid imported data and measures Unicode code points', () => {
 const input=fixtureGame(); input.name='🌿'.repeat(100); const result=validateGame(input); result.players[0].name='Changed'; expect(input.players[0].name).toBe('Alex');
 expect(()=>validateGame({...input,name:'🌿'.repeat(101)})).toThrow();
});
it.each([
 {schemaVersion:2}, {revision:0.5}, {revision:-1}, {createdAt:'yesterday'}, {updatedAt:'2026-02-30T00:00:00.000Z'}, {name:''}, {id:'x'.repeat(65)}, {secret:'credential'},
 {players:[{id:'p',name:'A',role:'gm'},{id:'p',name:'B',role:'pj'}]},
 {players:[{id:'p',name:'A',role:'gm'},{id:'q',name:' a ',role:'pj'}]},
 {players:[{id:'p',name:'A',role:'admin'}]},
 {rolls:[{id:'r',playerId:'missing',sides:20,value:2,at:'2026-10-27T12:00:00.000Z'}]},
 {rolls:[{id:'r',playerId:'alex',sides:20,value:21,at:'2026-10-27T12:00:00.000Z'}]},
 {rolls:Array(2).fill({id:'r',playerId:'alex',sides:20,value:2,at:'2026-10-27T12:00:00.000Z'})}
])('rejects malformed durable state %j', patch => expect(()=>validateGame({...fixtureGame(),...patch})).toThrow());
