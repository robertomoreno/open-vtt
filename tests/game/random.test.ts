import { expect, it } from 'vitest';
import { rollDie } from '../../src/game/random';
it('rejects biased tail words and yields bounded values', () => {
 const words=[4294967295,0,19]; expect(rollDie(20,()=>words.shift()!)).toBe(1); expect(rollDie(20,()=>words.shift()!)).toBe(20);
 expect(()=>rollDie(3 as 20)).toThrow();
});
