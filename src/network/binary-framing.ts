import { check } from '../game/validation';
import { FRAME_BYTES, FRAME_HEADER_BYTES, INCOMPLETE_TRANSFERS, MESSAGE_BYTES, MESSAGE_CHUNKS, PENDING_INBOUND_BYTES, TRANSFER_TIMEOUT_MS } from './limits';

const MAGIC = 0x47544832;
const VERSION = 2;
const PAYLOAD_BYTES = FRAME_BYTES - FRAME_HEADER_BYTES;

export type InboundBudget = { reserve(bytes: number): void; release(bytes: number): void; reserved(): number };

export function createInboundBudget(limit = PENDING_INBOUND_BYTES): InboundBudget {
  let used = 0;
  return {
    reserve(bytes) { check(used + bytes <= limit, 'Pending inbound data exceeds its budget.'); used += bytes; },
    release(bytes) { used = Math.max(0, used - bytes); },
    reserved: () => used,
  };
}

export function* encodeBinaryFrames(data: Uint8Array, transferId: number): Iterable<Uint8Array> {
  check(data.byteLength <= MESSAGE_BYTES, 'Message is too large.');
  check(Number.isInteger(transferId) && transferId >= 0 && transferId <= 0xffffffff, 'Invalid transfer ID.');
  const count = Math.max(1, Math.ceil(data.byteLength / PAYLOAD_BYTES));
  check(count <= MESSAGE_CHUNKS, 'Message has too many fragments.');
  for (let index = 0; index < count; index++) {
    const payload = data.subarray(index * PAYLOAD_BYTES, Math.min(data.byteLength, (index + 1) * PAYLOAD_BYTES));
    const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
    const view = new DataView(frame.buffer);
    view.setUint32(0, MAGIC);
    view.setUint8(4, VERSION);
    view.setUint8(5, 0);
    view.setUint32(6, transferId);
    view.setUint16(10, index);
    view.setUint16(12, count);
    view.setUint16(14, payload.byteLength);
    frame.set(payload, FRAME_HEADER_BYTES);
    yield frame;
  }
}

type Transfer = { count: number; startedAt: number; parts: Map<number, Uint8Array>; bytes: number };

export function createBinaryAssembler(now: () => number, budget: InboundBudget, onExpire?: () => void) {
  const transfers = new Map<number, Transfer>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
  const expire = (): boolean => {
    const time = now();
    let any = false;
    for (const [id, transfer] of [...transfers]) if (time - transfer.startedAt > TRANSFER_TIMEOUT_MS) { drop(id); any = true; }
    return any;
  };
  const schedule = () => {
    cancel();
    if (transfers.size === 0) return;
    const earliest = Math.min(...[...transfers.values()].map(transfer => transfer.startedAt));
    timer = setTimeout(() => { timer = undefined; const any = expire(); schedule(); if (any) onExpire?.(); }, Math.max(0, earliest + TRANSFER_TIMEOUT_MS + 1 - now()));
  };
  const drop = (id: number) => {
    const transfer = transfers.get(id);
    if (transfer) { budget.release(transfer.bytes); transfers.delete(id); }
  };
  return {
    accept(frame: Uint8Array): Uint8Array | undefined {
      try { return accept(frame); } finally { schedule(); }
    },
    clear() { cancel(); for (const id of [...transfers.keys()]) drop(id); },
  };
  function accept(frame: Uint8Array): Uint8Array | undefined {
    check(frame.byteLength >= FRAME_HEADER_BYTES && frame.byteLength <= FRAME_BYTES, 'Invalid frame size.');
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    check(view.getUint32(0) === MAGIC && view.getUint8(4) === VERSION && view.getUint8(5) === 0, 'Invalid frame header.');
    const id = view.getUint32(6), index = view.getUint16(10), count = view.getUint16(12), length = view.getUint16(14);
    check(count >= 1 && count <= MESSAGE_CHUNKS && index < count, 'Invalid frame index.');
    check(length === frame.byteLength - FRAME_HEADER_BYTES, 'Invalid frame length.');
    const time = now();
    check(!expire(), 'Transfer expired.');
    let transfer = transfers.get(id);
    if (!transfer) {
      check(transfers.size < INCOMPLETE_TRANSFERS, 'Too many incomplete transfers.');
      transfer = { count, startedAt: time, parts: new Map(), bytes: 0 };
      transfers.set(id, transfer);
    }
    try {
      check(transfer.count === count, 'Inconsistent fragment count.');
      check(!transfer.parts.has(index), 'Duplicate fragment.');
      check(transfer.bytes + length <= MESSAGE_BYTES, 'Message is too large.');
      budget.reserve(length);
    } catch (error) {
      drop(id);
      throw error;
    }
    transfer.bytes += length;
    transfer.parts.set(index, frame.slice(FRAME_HEADER_BYTES));
    if (transfer.parts.size < transfer.count) return undefined;
    const result = new Uint8Array(transfer.bytes);
    let offset = 0;
    for (let i = 0; i < transfer.count; i++) { const part = transfer.parts.get(i)!; result.set(part, offset); offset += part.byteLength; }
    drop(id);
    return result;
  }
}
