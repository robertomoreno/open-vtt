import { describe, expect, it } from 'vitest';
import { CHAT_BYTES, CHAT_IMAGE_DATA_URL_BYTES, CHAT_LIVE_BYTES, CHAT_RECORDS } from '../../src/network/limits';
import {
  canSeeChat, chatImageBytes, chatMessageBytes, normalizeRecipients,
  trimChatImages, trimChatMessages, validateChatImage, validateChatMessage,
  type ChatImage, type ChatMessage,
} from '../../src/game/chat';

const AT = '2026-11-09T10:00:00.000Z';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({ id: 'm1', playerId: 'alex', at: AT, text: 'Hello', recipients: null, ...over });
const image = (over: Partial<ChatImage> = {}): ChatImage => ({ id: 'i1', playerId: 'alex', at: AT, recipients: null, name: 'map.png', type: 'image/png', width: 1, height: 1, dataUrl: PNG, ...over });

describe('chat records', () => {
  it('validates public and private messages and filters audiences', () => {
    const pub = message(), priv = message({ recipients: ['alex', 'bea'] });
    expect(validateChatMessage(pub)).toEqual(pub);
    expect(validateChatMessage(priv)).toEqual(priv);
    expect(() => validateChatMessage(message({ recipients: ['bea'] }))).toThrow(/author/i);
    expect(canSeeChat(null, 'cy')).toBe(true);
    expect(canSeeChat(['alex', 'bea'], 'bea')).toBe(true);
    expect(canSeeChat(['alex', 'bea'], 'cy')).toBe(false);
    expect(canSeeChat(['alex'], null)).toBe(false);
  });

  it('always includes the author in a private audience', () => {
    expect(normalizeRecipients(null, 'alex')).toBeNull();
    expect(normalizeRecipients(['bea'], 'alex')).toEqual(['alex', 'bea']);
    expect(normalizeRecipients([], 'alex')).toEqual(['alex']);
  });

  it('keeps the newest 100 messages', () => {
    const messages = Array.from({ length: CHAT_RECORDS + 1 }, (_, i) => message({
      id: `m${String(i + 1).padStart(3, '0')}`,
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }));
    const kept = trimChatMessages(messages);
    expect(kept).toHaveLength(CHAT_RECORDS);
    expect(kept[0].id).toBe('m002');
    expect(kept.at(-1)!.id).toBe('m101');
  });

  it('keeps the newest messages within the byte budget', () => {
    const messages = Array.from({ length: 40 }, (_, i) => message({
      id: `m${String(i + 1).padStart(3, '0')}`,
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      text: '🧙'.repeat(2000),
    }));
    const kept = trimChatMessages(messages);
    expect(kept.length).toBeLessThan(40);
    expect(kept.reduce((sum, m) => sum + chatMessageBytes(m), 0)).toBeLessThanOrEqual(CHAT_BYTES);
    expect(kept.at(-1)!.id).toBe('m040');
  });

  it('validates image metadata and keeps the newest live images within bounds', () => {
    expect(validateChatImage(image())).toEqual(image());
    expect(() => validateChatImage(image({ type: 'image/svg+xml' as never }))).toThrow();
    expect(() => validateChatImage(image({ dataUrl: 'data:image/svg+xml;base64,AAAA' }))).toThrow();
    const big = 'data:image/png;base64,' + 'A'.repeat(180 * 1024);
    const images = Array.from({ length: 3 }, (_, i) => image({ id: `i${i}`, dataUrl: big, at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }));
    const kept = trimChatImages(images);
    expect(kept.length).toBeLessThan(3);
    expect(kept.reduce((sum, item) => sum + chatImageBytes(item), 0)).toBeLessThanOrEqual(CHAT_LIVE_BYTES);
    expect(kept.at(-1)!.id).toBe('i2');
  });
});
