import { expect,it } from 'vitest';
import { encodeFrames,createAssembler } from '../../src/network/framing';
it('reassembles large Unicode messages within small SCTP frames',()=>{
 const value={text:'🌿日本語'.repeat(9000)}, frames=encodeFrames(value), assembler=createAssembler(()=>0); let result:unknown;
 for(const frame of frames){expect(new TextEncoder().encode(frame).length).toBeLessThanOrEqual(16384);result=assembler.accept(frame);}
 expect(result).toEqual(value);
});
it('rejects duplicate, inconsistent, excessive, oversized and timed-out fragments',()=>{
 const frames=encodeFrames({text:'a'.repeat(7000)}); const a=createAssembler(()=>0); a.accept(frames[0]); expect(()=>a.accept(frames[0])).toThrow();
 const b=createAssembler(()=>0); b.accept(frames[0]); expect(()=>b.accept(JSON.stringify({...JSON.parse(frames[1]),count:99}))).toThrow();
 const c=createAssembler(()=>0);for(let n=0;n<4;n++)c.accept(encodeFrames('a'.repeat(7000))[0]); expect(()=>c.accept(encodeFrames('b'.repeat(7000))[0])).toThrow();
 let now=0; const d=createAssembler(()=>now);d.accept(frames[0]);now=10001;expect(()=>d.accept(frames[1])).toThrow();
 expect(()=>encodeFrames('a'.repeat(262145))).toThrow(); expect(()=>a.accept('x'.repeat(16385))).toThrow();
});
