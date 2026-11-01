import * as Y from 'yjs';
import { decodeRoomLink } from '../../../src/network/room-link';
import { createRoomTransport, type RoomTransport } from '../../../src/network/room';

const $ = (id: string) => document.getElementById(id)!;
const doc = new Y.Doc();
const map = doc.getMap<string | Uint8Array>('gate');
let transport: RoomTransport | undefined;
let unsubscribe: (() => void) | undefined;
const LARGE_BYTES = 1_500_000;
const largeValue = (seed: number) => Uint8Array.from({ length: LARGE_BYTES }, (_, i) => (i * 31 + seed * 17 + (i >> 8)) & 255);
function fnv(bytes: Uint8Array): number { let h = 0x811c9dc5; for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; } return h; }

function render(): void {
  const view = transport?.getView();
  $('phase').textContent = view?.phase ?? 'idle';
  $('opens').textContent = String(view?.openRtcConnections ?? 0);
  $('error').textContent = view?.error ?? '';
}
map.observe(() => {
  const value = map.get('small');
  $('received').textContent = typeof value === 'string' ? value : '';
  const large = map.get('large');
  $('large').textContent = large instanceof Uint8Array ? `${large.length}:${fnv(large)}` : '';
});
$('connect').addEventListener('click', () => {
  if (transport) return;
  transport = createRoomTransport(doc, decodeRoomLink((document.getElementById('link') as HTMLInputElement).value), (document.getElementById('participant') as HTMLInputElement).value);
  unsubscribe = transport.subscribe(render);
  render();
});
$('publish').addEventListener('click', () => { map.set('small', (document.getElementById('small-value') as HTMLInputElement).value); });
$('publish-large').addEventListener('click', () => { map.set('large', largeValue(7)); });
$('close').addEventListener('click', () => { unsubscribe?.(); transport?.close(); render(); transport = undefined; unsubscribe = undefined; $('phase').textContent = 'closed'; });
