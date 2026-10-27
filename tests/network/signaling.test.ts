import { expect, it } from 'vitest';
import { encodeSignal, decodeSignal, signalLink, type Signal } from '../../src/network/signaling';
const signal:Signal={version:1,kind:'offer',invitationId:'invite',description:{type:'offer',sdp:'日本語 🌿'}};
it('round trips UTF-8 codes and links without changing queries',()=>{
 const code=encodeSignal(signal); expect(code).toMatch(/^[\w-]+$/); expect(decodeSignal(code)).toEqual(signal);
 const link=signalLink(signal,'https://table.example/play?q=1#old'); expect(link).toContain('?q=1#invite='); expect(decodeSignal(link)).toEqual(signal);
});
it('rejects unsupported, mismatched and oversized signaling',()=>{
 for(const patch of [{version:2},{kind:'reply'},{description:{type:'answer',sdp:'x'}},{description:{type:'offer',sdp:'x'.repeat(65537)}}])expect(()=>encodeSignal({...signal,...patch} as Signal)).toThrow();
 expect(()=>decodeSignal('a'.repeat(131073))).toThrow(); expect(()=>decodeSignal('https://x/#reply='+encodeSignal(signal))).toThrow();
});
