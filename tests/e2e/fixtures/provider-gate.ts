import * as Y from 'yjs';
import { decodeRoomLink } from '../../../src/network/room-link';
import { createRoomTransport, type RoomTransport } from '../../../src/network/room';

const $ = (id: string) => document.getElementById(id)!;
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const doc = new Y.Doc();
const map = doc.getMap<string | Uint8Array>('gate');
let transport: RoomTransport | undefined;
let unsubscribe: (() => void) | undefined;
const LARGE_BYTES = 1_500_000;
const largeValue = (seed: number) => Uint8Array.from({ length: LARGE_BYTES }, (_, i) => (i * 31 + seed * 17 + (i >> 8)) & 255);
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function render(): void {
  const view = transport?.getView();
  $('phase').textContent = view?.phase ?? 'idle';
  $('opens').textContent = String(view?.openRtcConnections ?? 0);
  $('error').textContent = view?.error ?? '';
}
map.observe(() => {
  const strings: string[] = [];
  for (const [key, value] of [...map.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof value === 'string') strings.push(`${key}=${value}`);
    else if (value instanceof Uint8Array) {
      let out = document.querySelector(`[data-large="${key}"]`);
      if (!out) { out = document.createElement('output'); out.setAttribute('data-large', key); $('larges').append(out); }
      out.textContent = base64(value);
    }
  }
  $('received').textContent = strings.join('|');
});
$('connect').addEventListener('click', () => {
  if (transport) return;
  transport = createRoomTransport(doc, decodeRoomLink(input('link').value), input('participant').value);
  unsubscribe = transport.subscribe(render);
  render();
});
$('publish').addEventListener('click', () => { map.set(`small-${input('participant').value}`, input('small-value').value); });
$('publish-large').addEventListener('click', () => { map.set(`large-${input('participant').value}`, largeValue(Number(input('seed').value))); });
$('close').addEventListener('click', () => { unsubscribe?.(); transport?.close(); transport = undefined; unsubscribe = undefined; render(); $('phase').textContent = 'closed'; });
