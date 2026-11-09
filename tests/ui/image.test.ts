// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isSupportedChatImage, prepareChatImage } from '../../src/ui/image';
import { CHAT_SOURCE_BYTES } from '../../src/network/limits';

describe('chat image preparation', () => {
  it('accepts only PNG, JPEG and WebP within the source bound', () => {
    expect(isSupportedChatImage({ type: 'image/png', size: 10 })).toBe(true);
    expect(isSupportedChatImage({ type: 'image/jpeg', size: 10 })).toBe(true);
    expect(isSupportedChatImage({ type: 'image/webp', size: 10 })).toBe(true);
    expect(isSupportedChatImage({ type: 'image/svg+xml', size: 10 })).toBe(false);
    expect(isSupportedChatImage({ type: 'image/png', size: 0 })).toBe(false);
    expect(isSupportedChatImage({ type: 'image/png', size: CHAT_SOURCE_BYTES + 1 })).toBe(false);
  });

  it('rejects an unsupported file before trying to decode it', async () => {
    const file = new File(['x'], 'drawing.svg', { type: 'image/svg+xml' });
    await expect(prepareChatImage(file)).rejects.toThrow(/PNG|JPEG|WebP|image/i);
  });
});
