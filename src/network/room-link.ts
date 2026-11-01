import { check, id, object } from '../game/validation';
import { ROOM_LINK_DESCRIPTOR_BYTES, ROOM_LINK_INPUT_BYTES } from './limits';

export type RoomLink = { version: 2; roomId: string; gameId: string; secret: string };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const base64url = /^[A-Za-z0-9_-]+$/;
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const fragmentPrefix = '#room=';

function encodeBase64url(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
}

function validateRoomLink(value: unknown): RoomLink {
  const link = object(value, ['version', 'roomId', 'gameId', 'secret']);
  check(link.version === 2, 'Unsupported room link version.');
  check(typeof link.roomId === 'string' && uuid.test(link.roomId), 'Invalid room ID.');
  check(typeof link.secret === 'string' && secretPattern.test(link.secret), 'Invalid room secret.');
  check(decodeBase64url(link.secret).length === 32, 'Invalid room secret.');
  return { version: 2, roomId: link.roomId, gameId: id(link.gameId), secret: link.secret };
}

export function createRoomLink(gameId: string): RoomLink {
  const secret = encodeBase64url(crypto.getRandomValues(new Uint8Array(32)));
  return validateRoomLink({ version: 2, roomId: crypto.randomUUID(), gameId, secret });
}

export function roomLink(value: RoomLink, baseUrl: string): string {
  const link = validateRoomLink(value);
  const payload = encodeBase64url(new TextEncoder().encode(JSON.stringify(link)));
  check(payload.length <= ROOM_LINK_DESCRIPTOR_BYTES, 'Room link is too long.');
  const url = new URL(baseUrl);
  url.hash = fragmentPrefix + payload;
  return url.href;
}

export function decodeRoomLink(input: string): RoomLink {
  check(new TextEncoder().encode(input).length <= ROOM_LINK_INPUT_BYTES, 'Room link is too long.');
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Invalid room link.');
  }
  const payload = url.hash.startsWith(fragmentPrefix) ? url.hash.slice(fragmentPrefix.length) : '';
  check(payload.length > 0 && payload.length <= ROOM_LINK_DESCRIPTOR_BYTES && base64url.test(payload), 'Invalid room link.');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64url(payload)));
  } catch {
    throw new Error('Invalid room link.');
  }
  return validateRoomLink(value);
}
