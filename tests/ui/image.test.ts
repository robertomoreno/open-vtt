// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSupportedChatImage, prepareChatImage } from '../../src/ui/image';
import { CHAT_IMAGE_DATA_URL_BYTES, CHAT_SOURCE_BYTES } from '../../src/network/limits';

type EncodeCall = { type: string; quality: number | undefined; width: number; height: number };

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

function oversize(type: string): string {
  return `data:${type};base64,${'A'.repeat(CHAT_IMAGE_DATA_URL_BYTES)}`;
}

function fitting(type: string): string {
  return `data:${type};base64,AAAA`;
}

function imageFile(name = 'photo.png'): File {
  return new File([new Uint8Array(16)], name, { type: 'image/png' });
}

function stubCanvas(respond: (call: EncodeCall) => string) {
  const calls: EncodeCall[] = [];
  const drawImage = vi.fn();
  const clearRect = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue({ clearRect, drawImage } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL')
    .mockImplementation(function (this: HTMLCanvasElement, type?: string, quality?: number) {
      const call = { type: type ?? 'image/png', quality, width: this.width, height: this.height };
      calls.push(call);
      return respond(call);
    });
  return { calls, drawImage, clearRect };
}

function stubBitmap(width: number, height: number) {
  const close = vi.fn();
  const bitmap = { width, height, close };
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
  return { bitmap, close };
}

function stubNoBitmap(): void {
  vi.stubGlobal('createImageBitmap', undefined);
}

function stubImage(width: number, height: number, fail = false): void {
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = width;
    naturalHeight = height;
    width = width;
    height = height;
    set src(_value: string) {
      queueMicrotask(() => (fail ? this.onerror?.() : this.onload?.()));
    }
  }
  vi.stubGlobal('Image', FakeImage);
}

function stubObjectUrl(): { create: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn> } {
  const create = vi.fn(() => 'blob:chat-image');
  const revoke = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revoke });
  return { create, revoke };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalCreateObjectURL) URL.createObjectURL = originalCreateObjectURL;
  else delete (URL as unknown as Record<string, unknown>).createObjectURL;
  if (originalRevokeObjectURL) URL.revokeObjectURL = originalRevokeObjectURL;
  else delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
});

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

describe('chat image encoding', () => {
  it('scales a large image so the longest side is the chat dimension', async () => {
    const { bitmap, close } = stubBitmap(4000, 2000);
    const { calls, drawImage } = stubCanvas(() => fitting('image/webp'));

    const result = await prepareChatImage(imageFile());

    expect(result).toEqual({
      dataUrl: fitting('image/webp'),
      name: 'photo.png',
      type: 'image/webp',
      width: 1280,
      height: 640,
    });
    expect(calls[0]).toEqual({ type: 'image/webp', quality: 0.82, width: 1280, height: 640 });
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1280, 640);
    expect(close).toHaveBeenCalledOnce();
  });

  it('tries every configured dimension and quality in order when all results are oversized', async () => {
    const { close } = stubBitmap(4000, 2000);
    const { calls } = stubCanvas((call) =>
      call.type === 'image/webp' ? oversize('image/webp') : oversize('image/jpeg'));

    await expect(prepareChatImage(imageFile())).rejects.toThrow(/too large.*PNG.*JPEG.*WebP/i);

    expect(calls.map((call) => `${call.width}x${call.height}:${call.type}:${call.quality}`)).toEqual([
      '1280x640:image/webp:0.82',
      '1280x640:image/jpeg:0.82',
      '1024x512:image/webp:0.78',
      '1024x512:image/jpeg:0.78',
      '800x400:image/webp:0.72',
      '800x400:image/jpeg:0.72',
      '640x320:image/webp:0.65',
      '640x320:image/jpeg:0.65',
    ]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('retries at a smaller dimension when the current dimension is over budget', async () => {
    stubBitmap(4000, 2000);
    const { calls } = stubCanvas((call) =>
      call.width >= 1280
        ? (call.type === 'image/webp' ? oversize('image/webp') : oversize('image/jpeg'))
        : fitting('image/webp'));

    const result = await prepareChatImage(imageFile());

    expect(result).toMatchObject({ type: 'image/webp', width: 1024, height: 512 });
    expect(result.dataUrl).toBe(fitting('image/webp'));
    expect(calls.map((call) => `${call.width}:${call.type}`)).toEqual([
      '1280:image/webp',
      '1280:image/jpeg',
      '1024:image/webp',
    ]);
  });

  it('falls back to JPEG when the browser returns a non-WebP data URL', async () => {
    stubBitmap(4000, 2000);
    const { calls } = stubCanvas((call) =>
      call.type === 'image/webp' ? fitting('image/png') : fitting('image/jpeg'));

    const result = await prepareChatImage(imageFile());

    expect(result).toMatchObject({ type: 'image/jpeg', width: 1280, height: 640 });
    expect(result.dataUrl).toBe(fitting('image/jpeg'));
    expect(calls.map((call) => call.type)).toEqual(['image/webp', 'image/jpeg']);
  });

  it('revokes the temporary object URL after a successful fallback decode', async () => {
    stubNoBitmap();
    stubImage(4000, 2000);
    const { create, revoke } = stubObjectUrl();
    stubCanvas(() => fitting('image/webp'));

    const result = await prepareChatImage(imageFile());

    expect(result).toMatchObject({ type: 'image/webp', width: 1280, height: 640 });
    expect(create).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:chat-image');
  });

  it('revokes the temporary object URL when decoding fails', async () => {
    stubNoBitmap();
    stubImage(0, 0, true);
    const { create, revoke } = stubObjectUrl();
    const { calls } = stubCanvas(() => fitting('image/webp'));

    await expect(prepareChatImage(imageFile())).rejects.toThrow(/could not be read/i);

    expect(create).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:chat-image');
    expect(calls).toHaveLength(0);
  });
});
