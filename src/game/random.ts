import type { Runtime, DieSides } from './types';
import { sides as validateSides, check } from './validation';
export function rollDie(sides: DieSides, word=()=>crypto.getRandomValues(new Uint32Array(1))[0]): number {
  validateSides(sides); const limit=Math.floor(2**32/sides)*sides; let n: number;
  do { n=word(); check(Number.isInteger(n) && n>=0 && n<2**32,'Invalid random word.'); } while(n>=limit);
  return n%sides+1;
}
export const browserRuntime: Runtime={id:()=>crypto.randomUUID(),now:()=>new Date().toISOString(),die:rollDie};
