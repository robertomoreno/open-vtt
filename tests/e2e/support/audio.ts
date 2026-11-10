const SAMPLE_RATE = 44_100;
const SECONDS = 30;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const FREQUENCY_HZ = 440;
const AMPLITUDE = 0.25;
const HEADER_BYTES = 44;

let cached: Buffer | null = null;

/**
 * A deterministic 30-second 44.1 kHz mono 16-bit PCM WAV with a 440 Hz tone.
 *
 * At about 2.5 MiB it is deliberately larger than the 2 MiB per-message wrapper
 * bound, so an end-to-end transfer proves action chunking across the framing
 * layer rather than only moving a small payload. The file is generated in code;
 * no audio bytes live in the repository.
 */
export function wavFixture(): Buffer {
  if (cached !== null) return cached;
  const samples = SAMPLE_RATE * SECONDS;
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;
  const dataBytes = samples * blockAlign;
  const buffer = Buffer.alloc(HEADER_BYTES + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  const peak = Math.round(AMPLITUDE * 32767);
  const step = (2 * Math.PI * FREQUENCY_HZ) / SAMPLE_RATE;
  for (let index = 0; index < samples; index++) {
    buffer.writeInt16LE(Math.round(peak * Math.sin(step * index)), HEADER_BYTES + index * blockAlign);
  }

  cached = buffer;
  return buffer;
}
