// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { serializeGame, parseGameFile, downloadGame } from '../../src/storage/files';
import { fixtureGame } from '../helpers/game';
it('does not export identity or connection state',()=>{
 const g=fixtureGame(); expect(JSON.parse(serializeGame(g))).toEqual(g); expect(()=>serializeGame({...g,connection:'secret'} as typeof g)).toThrow();
});
it('rejects invalid files without repository writes',async()=>{
 const text=vi.fn(); await expect(parseGameFile({size:1048577,text} as unknown as File)).rejects.toThrow(); expect(text).not.toHaveBeenCalled();
 await expect(parseGameFile({size:20,text:async()=>'{"schemaVersion":2}'} as File)).rejects.toThrow();
 const g={...fixtureGame(),name:'日本語 🌿'}; expect(await parseGameFile({size:300,text:async()=>serializeGame(g)} as File)).toEqual(g);
});
it('revokes download object URLs and removes the anchor',()=>{
 vi.useFakeTimers(); const revoke=vi.fn(); Object.assign(URL,{createObjectURL:()=> 'blob:test',revokeObjectURL:revoke}); vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
 downloadGame(fixtureGame()); expect(document.querySelector('a')).toBeNull(); vi.runAllTimers(); expect(revoke).toHaveBeenCalledWith('blob:test'); vi.restoreAllMocks(); vi.useRealTimers();
});
