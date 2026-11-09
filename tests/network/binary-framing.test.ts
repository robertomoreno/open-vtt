import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBinaryAssembler, createInboundBudget, encodeBinaryFrames } from '../../src/network/binary-framing';

const MiB = 1024 * 1024;
const frames = (bytes: Uint8Array, id = 1) => [...encodeBinaryFrames(bytes, id)];
function header(frame: Uint8Array, patch: (view: DataView) => void): Uint8Array {
  const copy = frame.slice();
  patch(new DataView(copy.buffer));
  return copy;
}

describe('binary framing', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('frames and exactly reassembles a 2-MiB binary sync message', () => {
    const bytes = new Uint8Array(2 * MiB).fill(7);
    const assembler = createBinaryAssembler(() => 0, createInboundBudget(), vi.fn());
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
    const assembler = createBinaryAssembler(() => 0, createInboundBudget(), vi.fn());
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
    expect(() => createBinaryAssembler(() => 0, createInboundBudget(), vi.fn()).accept(frame)).toThrow();
  });

  it('rejects a duplicate fragment', () => {
    const assembler = createBinaryAssembler(() => 0, createInboundBudget(), vi.fn());
    const [first] = frames(new Uint8Array(40_000), 1);
    assembler.accept(first);
    expect(() => assembler.accept(first)).toThrow();
  });

  it('rejects a transfer whose declared fragments exceed 2 MiB', () => {
    const assembler = createBinaryAssembler(() => 0, createInboundBudget(), vi.fn());
    const full = frames(new Uint8Array(2 * MiB), 1);
    const extra = header(full[0], v => { v.setUint16(10, 129); v.setUint16(12, 130); });
    const rest = full.slice(0, 128).map(f => header(f, v => v.setUint16(12, 130)));
    expect(() => { rest.forEach(f => assembler.accept(f)); assembler.accept(extra); }).toThrow();
  });

  it('rejects a fifth incomplete transfer on one connection', () => {
    const assembler = createBinaryAssembler(() => 0, createInboundBudget(), vi.fn());
    for (let id = 1; id <= 4; id++) assembler.accept(frames(new Uint8Array(40_000), id)[0]);
    expect(() => assembler.accept(frames(new Uint8Array(40_000), 5)[0])).toThrow();
  });

  it('rejects aggregate pending bytes above 16 MiB across connections and recovers after clear', () => {
    const budget = createInboundBudget();
    const assemblers = Array.from({ length: 9 }, () => createBinaryAssembler(() => 0, budget, vi.fn()));
    const partial = (id: number) => frames(new Uint8Array(2 * MiB), id).slice(0, 128);
    // Eight nearly-2-MiB partial transfers fit under the 16 MiB aggregate; the ninth does not.
    for (let i = 0; i < 8; i++) for (const frame of partial(i + 1)) assemblers[i].accept(frame);
    expect(budget.reserved()).toBeGreaterThan(15 * MiB);
    expect(budget.reserved()).toBeLessThanOrEqual(16 * MiB);
    expect(() => partial(9).forEach(f => assemblers[8].accept(f))).toThrow();
    assemblers[0].clear();
    expect(() => assemblers[8].accept(frames(new Uint8Array(40_000), 10)[0])).not.toThrow();
    for (const assembler of assemblers) assembler.clear();
  });

  it('expires an incomplete transfer 10,001 ms after its last fragment and releases its bytes', () => {
    let now = 0;
    const budget = createInboundBudget();
    const assembler = createBinaryAssembler(() => now, budget, vi.fn());
    const [first, second, third] = frames(new Uint8Array(40_000), 1);
    assembler.accept(first);
    now = 10_000;
    expect(assembler.accept(second)).toBeUndefined();
    now = 20_001;
    expect(() => assembler.accept(third)).toThrow();
    expect(budget.reserved()).toBe(0);
  });

  it('expires and releases an idle incomplete transfer at 10,001 ms with no further input, then leaves no timer', () => {
    const budget = createInboundBudget();
    const assembler = createBinaryAssembler(() => Date.now(), budget, vi.fn());
    assembler.accept(frames(new Uint8Array(40_000), 1)[0]);
    expect(budget.reserved()).toBe(16_368);
    vi.advanceTimersByTime(10_000);
    expect(budget.reserved()).toBe(16_368);
    vi.advanceTimersByTime(1);
    expect(budget.reserved()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clear() cancels the expiry timer and releases reservations', () => {
    const budget = createInboundBudget();
    const assembler = createBinaryAssembler(() => Date.now(), budget, vi.fn());
    assembler.accept(frames(new Uint8Array(40_000), 1)[0]);
    assembler.clear();
    expect(budget.reserved()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires each incomplete transfer by its own start time', () => {
    const budget = createInboundBudget();
    const assembler = createBinaryAssembler(() => Date.now(), budget, vi.fn());
    assembler.accept(frames(new Uint8Array(40_000), 1)[0]);
    vi.advanceTimersByTime(6_000);
    assembler.accept(frames(new Uint8Array(40_000), 2)[0]);
    vi.advanceTimersByTime(4_001);
    expect(budget.reserved()).toBe(16_368);
    vi.advanceTimersByTime(6_000);
    expect(budget.reserved()).toBe(0);
  });

  it('signals the owner exactly once when a transfer expires with no further input', () => {
    const budget = createInboundBudget();
    let expired = 0;
    const ids: number[] = [];
    const assembler = createBinaryAssembler(() => Date.now(), budget, id => { expired++; ids.push(id); });
    assembler.accept(frames(new Uint8Array(40_000), 1)[0]);
    vi.advanceTimersByTime(10_000);
    expect(expired).toBe(0);
    vi.advanceTimersByTime(1);
    expect(expired).toBe(1);
    expect(ids).toEqual([1]);
    expect(budget.reserved()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(expired).toBe(1);
  });

  it('fails the next frame when any other transfer expired, instead of silently dropping it', () => {
    let now = 0;
    const assembler = createBinaryAssembler(() => now, createInboundBudget(), vi.fn());
    assembler.accept(frames(new Uint8Array(40_000), 1)[0]);
    now = 10_001;
    expect(() => assembler.accept(frames(new Uint8Array(40_000), 2)[0])).toThrow();
  });

  it('measures inactivity, not total age: an actively progressing transfer lasting over 10 s is accepted', () => {
    let now = 0;
    const expired = vi.fn();
    const budget = createInboundBudget();
    const assembler = createBinaryAssembler(() => now, budget, expired);
    const all = frames(new Uint8Array(2 * MiB), 5);
    let result: Uint8Array | undefined;
    for (const frame of all) { now += 100; result = assembler.accept(frame); }
    expect(now).toBeGreaterThan(10_000);
    expect(result?.byteLength).toBe(2 * MiB);
    expect(expired).not.toHaveBeenCalled();
    expect(budget.reserved()).toBe(0);
  });

  it('expires a transfer 10,001 ms after its last valid fragment even if it started long ago', () => {
    let now = 0;
    const expired = vi.fn();
    const assembler = createBinaryAssembler(() => now, createInboundBudget(), expired);
    const all = frames(new Uint8Array(100_000), 6);
    assembler.accept(all[0]);
    now = 9_000; assembler.accept(all[1]);
    now = 19_000; expect(() => assembler.accept(all[2])).not.toThrow();
    now = 29_001;
    expect(() => assembler.accept(all[3])).toThrow();
  });

  it('timer-expires a silent transfer relative to its last valid fragment', () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const assembler = createBinaryAssembler(() => Date.now(), createInboundBudget(), expired);
    const all = frames(new Uint8Array(100_000), 7);
    assembler.accept(all[0]);
    vi.advanceTimersByTime(6_000); assembler.accept(all[1]);
    vi.advanceTimersByTime(10_000);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledWith(7);
  });
});
