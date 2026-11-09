import type { ChatImageInput, ChatImageType } from '../game/chat';
import { CHAT_IMAGE_DATA_URL_BYTES, CHAT_IMAGE_DIMENSION, CHAT_SOURCE_BYTES } from '../network/limits';

const IMAGE_TYPES: readonly ChatImageType[] = ['image/png', 'image/jpeg', 'image/webp'];
const OUTPUT_TYPES: readonly ChatImageType[] = ['image/webp', 'image/jpeg'];
const ATTEMPTS: readonly { size: number; quality: number }[] = [
  { size: 1280, quality: 0.82 },
  { size: 1024, quality: 0.78 },
  { size: 800, quality: 0.72 },
  { size: 640, quality: 0.65 },
];
const DATA_URL_TYPE = /^data:(image\/(?:png|jpeg|webp));base64,/;

const TYPE_MESSAGE = 'Choose a PNG, JPEG or WebP image.';
const EMPTY_MESSAGE = 'Choose a non-empty PNG, JPEG or WebP image.';
const SIZE_MESSAGE = `Choose a PNG, JPEG or WebP image no larger than ${megabytes(CHAT_SOURCE_BYTES)}.`;
const DECODE_MESSAGE = 'This browser cannot decode that image for chat.';
const ENCODE_MESSAGE = 'This browser cannot prepare images for chat.';
const OVERSIZE_MESSAGE = `That image is too large to share. Choose a PNG, JPEG or WebP image no larger than ${megabytes(CHAT_SOURCE_BYTES)}.`;

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

type DecodedImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
};

export function isSupportedChatImage(file: { type: string; size: number }): boolean {
  return IMAGE_TYPES.includes(file.type as ChatImageType)
    && typeof file.size === 'number'
    && file.size > 0
    && file.size <= CHAT_SOURCE_BYTES;
}

async function decodeFallback(file: File): Promise<DecodedImage> {
  if (typeof Image === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error(DECODE_MESSAGE);
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('That image could not be read.'));
      image.src = url;
    });
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    return { source: image, width, height, release: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof globalThis.createImageBitmap === 'function') {
    try {
      const bitmap = await globalThis.createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // Fall through to the HTMLImageElement path when bitmap decoding is unavailable.
    }
  }
  return decodeFallback(file);
}

function encodedType(dataUrl: string): ChatImageType | null {
  const match = DATA_URL_TYPE.exec(dataUrl);
  return match ? (match[1] as ChatImageType) : null;
}

function encodeImage(decoded: DecodedImage, file: File): ChatImageInput {
  if (typeof document === 'undefined') throw new Error(ENCODE_MESSAGE);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context || typeof canvas.toDataURL !== 'function') throw new Error(ENCODE_MESSAGE);

  const longest = Math.max(decoded.width, decoded.height);
  if (!(longest > 0)) throw new Error(DECODE_MESSAGE);

  let encoded = false;
  for (const attempt of ATTEMPTS) {
    const scale = Math.min(1, Math.min(attempt.size, CHAT_IMAGE_DIMENSION) / longest);
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    canvas.width = width;
    canvas.height = height;
    context.clearRect(0, 0, width, height);
    context.drawImage(decoded.source, 0, 0, width, height);

    for (const requested of OUTPUT_TYPES) {
      const dataUrl = canvas.toDataURL(requested, attempt.quality);
      const type = encodedType(dataUrl);
      if (type !== requested) continue;
      encoded = true;
      if (dataUrl.length > CHAT_IMAGE_DATA_URL_BYTES) break;
      return { dataUrl, name: (file.name || 'image').slice(0, 100), type, width, height };
    }
  }

  throw new Error(encoded ? OVERSIZE_MESSAGE : ENCODE_MESSAGE);
}

export async function prepareChatImage(file: File): Promise<ChatImageInput> {
  if (!IMAGE_TYPES.includes(file.type as ChatImageType)) throw new Error(TYPE_MESSAGE);
  if (!(file.size > 0)) throw new Error(EMPTY_MESSAGE);
  if (file.size > CHAT_SOURCE_BYTES) throw new Error(SIZE_MESSAGE);

  const decoded = await decodeImage(file);
  try {
    return encodeImage(decoded, file);
  } finally {
    decoded.release();
  }
}
