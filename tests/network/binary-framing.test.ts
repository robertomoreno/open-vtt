import { describe, expect, it } from 'vitest';
import { createBinaryAssembler, createInboundBudget, encodeBinaryFrames } from '../../src/network/binary-framing';

const MiB = 1024 * 1024;
const frames = (bytes: Uint8Array, id = 1) => [...encodeBinaryFrames(bytes, id)];
function header(frame: Uint8Array, patch: (view: DataView) => void): Uint8Array {
  const copy = frame.slice();
  patch(new DataView(copy.buffer));
  return copy;
}

describe('binary framing', () => {
  it('frames and exactly reassembles a 2-MiB binary sync message', () => {
    const bytes = new Uint8Array(2 * MiB).fill(7);
    const assembler = createBinaryAssembler(() => 0, createInboundBudget());
    let result: Uint8Array | undefined;
    for (const frame of encodeBinaryFrames(bytes, 1)) {
      expect(frame.byteLength).toBeLessThanOrEqual(16_384);
      result = assembler.accept(frame);
    }
    expect(result).toEqual(bytes);
  });

  it('writes the documented big-endian header', () => {
    const [frame] = frames(Uint8Array.of(9, 8, 7), 0x01020304);
    expect([...frame.subarray(0, 16)]).toEqual([0x47, 0x54, 0x48, 0x32, 2, 0, 1, 2, 3, 4, 0, 0, 0, 1, 0, 3]);
    expect([...frame.subarray(16)]).toEqual([9, 8, 7]);
  });

  it('reassembles an empty message and out-of-order-free interleaved transfers', () => {
    const assembler = createBinaryAssembler(() => 0, createInboundBudget());
    const a = frames(new Uint8Array(20_000).fill(1), 1), b = frames(new Uint8Array(20_000).fill(2), 2);
    expect(assembler.accept(a[0])).toBeUndefined();
    expect(assembler.accept(b[0])).toBeUndefined();
    expect(assembler.accept(b[1])).toEqual(new Uint8Array(20_000).fill(2));
    expect(assembler.accept(a[1])).toEqual(new Uint8Array(20_000).fill(1));
    expect(assembler.accept(frames(new Uint8Array(0), 3)[0])).toEqual(new Uint8Array(0));
  });

  it('refuses to encode more than 2 MiB', () => {
    expect(() => [...encodeBinaryFrames(new Uint8Array(2 * MiB + 1), 1)]).toThrow();
  });

  it('is lazy: no fragment is produced until it is requested', () => {
    const iterator = encodeBinaryFrames(new Uint8Array(2 * MiB), 1)[Symbol.iterator]();
    const first = iterator.next().value as Uint8Array;
    const second = iterator.next().value as Uint8Array;
    expect(first.buffer).not.toBe(second.buffer);
  });

  const [good] = frames(new Uint8Array(40_000), 5);
  it.each([
    ['bad magic', header(good, v => v.setUint32(0, 1))],
    ['bad version', header(good, v => v.setUint8(4, 3))],
    ['nonzero flags', header(good, v => v.setUint8(5, 1))],
    ['zero count', header(good, v => v.setUint16(12, 0))],
    ['count over 256', header(good, v => v.setUint16(12, 257))],
    ['index not below count', header(good, v => v.setUint16(10, 3))],
    ['length mismatch', header(good, v => v.setUint16(14, 5))],
    ['short frame', good.subarray(0, 10)],
    ['oversized frame', new Uint8Array(16_385)],
  ])('rejects %s', (_name, frame) => {
    expect(() => createBinaryAssembler(() => 0, createInboundBudget()).accept(frame)).toThrow();
  });

  it('rejects a duplicate fragment', () => {
    const assembler = createBinaryAssembler(() => 0, createInboundBudget());
    const [first] = frames(new Uint8Array(40_000), 1);
    assembler.accept(first);
    expect(() => assembler.accept(first)).toThrow();
  });

  it('rejects a transfer whose declared fragments exceed 2 MiB', () => {
    const assembler = createBinaryAssembler(() => 0, createInboundBudget());
    const full = frames(new Uint8Array(2 * MiB), 1);
    const extra = header(full[0], v => { v.setUint16(10, 129); v.setUint16(12, 130); });
    const rest = full.slice(0, 128).map(f => header(f, v => v.setUint16(12, 130)));
    expect(() => { rest.forEach(f => assembler.accept(f)); assembler.accept(extra); }).toThrow();
  });

  it('rejects a fifth incomplete transfer on one connection', () => {
    const assembler = createBinaryAssembler(() => 0, createInboundBudget());
    for (let id = 1; id <= 4; id++) assembler.accept(frames(new Uint8Array(40_000), id)[0]);
    expect(() => assembler.accept(frames(new Uint8Array(40_000), 5)[0])).toThrow();
  });

  it('rejects aggregate pending bytes above 8 MiB across connections and recovers after clear', () => {
    const budget = createInboundBudget();
    const assemblers = Array.from({ length: 5 }, () => createBinaryAssembler(() => 0, budget));
    const partial = (id: number) => frames(new Uint8Array(2 * MiB), id).slice(0, 128);
    for (const frame of partial(1)) assemblers[0].accept(frame);
    for (const frame of partial(2)) assemblers[1].accept(frame);
    for (const frame of partial(3)) assemblers[2].accept(frame);
    for (const frame of partial(4)) assemblers[3].accept(frame);
    expect(() => partial(5).forEach(f => assemblers[4].accept(f))).toThrow();
    assemblers[0].clear();
    expect(() => assemblers[4].accept(frames(new Uint8Array(40_000), 6)[0])).not.toThrow();
  });

  it('expires an incomplete transfer after 10,000 ms and releases its bytes', () => {
    let now = 0;
    const budget = createInboundBudget();
    const assembler = createBinaryAssembler(() => now, budget);
    const [first, second, third] = frames(new Uint8Array(40_000), 1);
    assembler.accept(first);
    now = 10_000;
    expect(assembler.accept(second)).toBeUndefined();
    now = 10_001;
    expect(() => assembler.accept(third)).toThrow();
    expect(budget.reserved()).toBe(0);
  });
});
