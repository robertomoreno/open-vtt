import {
  CHAT_BYTES, CHAT_IMAGE_DATA_URL_BYTES, CHAT_IMAGE_DIMENSION, CHAT_IMAGES,
  CHAT_LIVE_BYTES, CHAT_RECORDS, CHAT_TEXT_CHARS,
} from '../network/limits';
import { check, id, integer, object, text, timestamp } from './validation';

export type ChatRecipients = string[] | null;
export type ChatImageType = 'image/png' | 'image/jpeg' | 'image/webp';
export type ChatMessage = {
  id: string;
  playerId: string;
  at: string;
  text: string;
  recipients: ChatRecipients;
};
export type ChatImageInput = {
  name: string;
  type: ChatImageType;
  width: number;
  height: number;
  dataUrl: string;
};
export type ChatImage = ChatImageInput & {
  id: string;
  playerId: string;
  at: string;
  recipients: ChatRecipients;
};

const IMAGE_TYPES: readonly ChatImageType[] = ['image/png', 'image/jpeg', 'image/webp'];
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const encoder = new TextEncoder();

function chatText(value: unknown): string {
  check(typeof value === 'string', 'Chat text must be a string.');
  return text(value.trim(), CHAT_TEXT_CHARS);
}

function recipientIds(value: unknown, author: string): string[] {
  check(Array.isArray(value), 'Invalid chat recipients.');
  check(value.length >= 1 && value.length <= 32, 'Chat needs 1–32 recipients.');
  const recipients = value.map(id);
  check(new Set(recipients).size === recipients.length, 'Duplicate chat recipient.');
  check(recipients.every((recipient, index) => index === 0 || recipients[index - 1] <= recipient), 'Chat recipients must be sorted.');
  check(recipients.includes(author), 'Private chat must include the author.');
  return recipients;
}

export function validateChatMessage(value: unknown): ChatMessage {
  const message = object(value, ['id', 'playerId', 'at', 'text', 'recipients']);
  const playerId = id(message.playerId);
  const recipients = message.recipients === null ? null : recipientIds(message.recipients, playerId);
  return { id: id(message.id), playerId, at: timestamp(message.at), text: chatText(message.text), recipients };
}

export function validateChatImage(value: unknown): ChatImage {
  const image = object(value, ['id', 'playerId', 'at', 'recipients', 'name', 'type', 'width', 'height', 'dataUrl']);
  check(IMAGE_TYPES.includes(image.type as ChatImageType), 'Unsupported image type.');
  const type = image.type as ChatImageType;
  const dataUrl = image.dataUrl;
  check(typeof dataUrl === 'string' && dataUrl.length <= CHAT_IMAGE_DATA_URL_BYTES, 'Image data URL is invalid or oversized.');
  const match = IMAGE_DATA_URL.exec(dataUrl);
  check(match !== null && `image/${match[1]}` === type, 'Image data URL does not match its type.');
  const width = integer(image.width, 1), height = integer(image.height, 1);
  check(width <= CHAT_IMAGE_DIMENSION && height <= CHAT_IMAGE_DIMENSION, 'Image dimensions are too large.');
  const playerId = id(image.playerId);
  const recipients = image.recipients === null ? null : recipientIds(image.recipients, playerId);
  return { id: id(image.id), playerId, at: timestamp(image.at), recipients, name: text(image.name, 100), type, width, height, dataUrl };
}

export function normalizeRecipients(recipients: readonly string[] | null, authorId: string): ChatRecipients {
  const author = id(authorId);
  if (recipients === null) return null;
  check(Array.isArray(recipients), 'Invalid chat recipients.');
  const normalized = [...new Set([...recipients.map(id), author])].sort();
  check(normalized.length <= 32, 'Chat needs at most 32 recipients.');
  return normalized;
}

export function canSeeChat(recipients: ChatRecipients, playerId: string | null): boolean {
  return recipients === null || (playerId !== null && recipients.includes(playerId));
}

export function sortChatRecords<T extends { at: string; id: string }>(records: readonly T[]): T[] {
  return [...records].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function chatMessageBytes(message: ChatMessage): number {
  return encoder.encode(JSON.stringify(message)).byteLength;
}

export function chatImageBytes(image: ChatImage): number {
  return encoder.encode(JSON.stringify(image)).byteLength;
}

function dedupe<T extends { id: string }>(records: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const record of records) {
    if (!byId.has(record.id)) byId.set(record.id, record);
    else check(JSON.stringify(byId.get(record.id)) === JSON.stringify(record), 'Conflicting chat records share an ID.');
  }
  return [...byId.values()];
}

function trim<T extends { id: string; at: string }>(records: readonly T[], limit: number, bytes: number, size: (record: T) => number): T[] {
  const sorted = sortChatRecords(dedupe(records));
  const kept: T[] = [];
  let total = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const record = sorted[i], recordBytes = size(record);
    if (kept.length >= limit) break;
    if (kept.length > 0 && total + recordBytes > bytes) break;
    kept.push(record);
    total += recordBytes;
  }
  return kept.reverse();
}

export function trimChatMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return trim(messages, CHAT_RECORDS, CHAT_BYTES, chatMessageBytes);
}

export function trimChatImages(images: readonly ChatImage[]): ChatImage[] {
  return trim(images, CHAT_IMAGES, CHAT_LIVE_BYTES, chatImageBytes);
}
