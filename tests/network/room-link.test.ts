import { describe, expect, it } from 'vitest';
import { createRoomLink, decodeRoomLink, roomLink } from '../../src/network/room-link';

const encodeSignal = (signal: unknown) => {
  const data = new TextEncoder().encode(JSON.stringify(signal));
  let binary = '';
  for (const n of data) binary += String.fromCharCode(n);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const encodePayload = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const linkWith = (payload: string) => `https://example.test/table#room=${payload}`;
const validDescriptor = () => createRoomLink('game');

describe('room links', () => {
  it('roundtrips fragment-only room/game IDs without SDP or a game payload', () => {
    const descriptor = createRoomLink('game');
    const url = new URL(roomLink(descriptor, 'https://example.test/table?theme=light'));
    expect(decodeRoomLink(url.href)).toEqual(descriptor);
    expect(url.search).toBe('?theme=light');
    expect(url.hash.startsWith('#room=')).toBe(true);
    expect(descriptor.secret).toHaveLength(43);
    expect(Object.keys(descriptor).sort()).toEqual(['gameId', 'roomId', 'secret', 'version']);
  });

  it('rejects an unsupported link version', () => {
    const { roomId, gameId, secret } = validDescriptor();
    expect(() => decodeRoomLink(linkWith(encodePayload({ version: 1, roomId, gameId, secret })))).toThrow();
  });

  it('rejects extra keys in the descriptor', () => {
    const { roomId, gameId, secret } = validDescriptor();
    expect(() => decodeRoomLink(linkWith(encodePayload({ version: 2, roomId, gameId, secret, sdp: 'x' })))).toThrow();
  });

  it('rejects a secret that does not decode to 32 bytes', () => {
    const { roomId, gameId } = validDescriptor();
    const shortSecret = Buffer.alloc(31, 7).toString('base64url');
    expect(() => decodeRoomLink(linkWith(encodePayload({ version: 2, roomId, gameId, secret: shortSecret })))).toThrow();
  });

  it('rejects a non-UUID room ID and an invalid game ID', () => {
    const { secret, gameId, roomId } = validDescriptor();
    expect(() => decodeRoomLink(linkWith(encodePayload({ version: 2, roomId: 'not-a-uuid', gameId, secret })))).toThrow();
    expect(() => decodeRoomLink(linkWith(encodePayload({ version: 2, roomId, gameId: '  ', secret })))).toThrow();
  });

  it('rejects oversized input', () => {
    const { roomId, gameId, secret } = validDescriptor();
    const padded = encodePayload({ version: 2, roomId, gameId, secret, pad: 'x'.repeat(9000) });
    expect(() => decodeRoomLink(linkWith(padded))).toThrow();
  });

  it('rejects a legacy connection reply', () => {
    const reply = encodeSignal({
      version: 1,
      kind: 'answer',
      invitationId: 'invitation',
      description: { type: 'answer', sdp: 'v=0' },
    });
    expect(() => decodeRoomLink(`https://example.test/table#${reply}`)).toThrow();
    expect(() => decodeRoomLink(linkWith(reply))).toThrow();
  });
});
