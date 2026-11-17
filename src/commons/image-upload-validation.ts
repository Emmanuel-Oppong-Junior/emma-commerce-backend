import { BadRequestException } from '@nestjs/common';

export const MAX_IMAGE_FILE_SIZE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;

export type AllowedImageFormat = 'jpeg' | 'png' | 'webp';

interface ImageDimensions {
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Identifies the image format from its magic bytes (ignoring the client-supplied mimetype and name),
 * reads its dimensions from the header and rejects anything outside the allowlist or over the pixel limit.
 */
export function assertAllowedImage(buffer: Buffer, fileName: string): AllowedImageFormat {
  if (buffer.length > MAX_IMAGE_FILE_SIZE_BYTES) {
    throw new BadRequestException(
      `File "${fileName}" is ${buffer.length} bytes; the limit is ${MAX_IMAGE_FILE_SIZE_BYTES} bytes`,
    );
  }
  const format = detectImageFormat(buffer);
  if (!format) {
    throw new BadRequestException(`File "${fileName}" is not a JPEG, PNG or WebP image`);
  }
  const dimensions = readDimensions(buffer, format);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    throw new BadRequestException(`File "${fileName}" has an unreadable ${format} header`);
  }
  const pixels = dimensions.width * dimensions.height;
  if (pixels > MAX_IMAGE_PIXELS) {
    throw new BadRequestException(
      `File "${fileName}" is ${dimensions.width}x${dimensions.height} (${pixels} pixels); the limit is ${MAX_IMAGE_PIXELS} pixels`,
    );
  }
  return format;
}

function detectImageFormat(buffer: Buffer): AllowedImageFormat | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (buffer.length >= 12 && ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 4) === 'WEBP') return 'webp';
  return null;
}

function readDimensions(buffer: Buffer, format: AllowedImageFormat): ImageDimensions | null {
  switch (format) {
    case 'png':
      return readPngDimensions(buffer);
    case 'webp':
      return readWebpDimensions(buffer);
    case 'jpeg':
      return readJpegDimensions(buffer);
  }
}

function readPngDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 24 || ascii(buffer, 12, 4) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readWebpDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 30) return null;
  switch (ascii(buffer, 12, 4)) {
    case 'VP8 ':
      if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return null;
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    case 'VP8L': {
      if (buffer[20] !== 0x2f) return null;
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case 'VP8X':
      return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
    default:
      return null;
  }
}

function readJpegDimensions(buffer: Buffer): ImageDimensions | null {
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;
    if (isStartOfFrame(marker)) {
      if (offset + 9 > buffer.length) return null;
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + segmentLength;
  }
  return null;
}

// SOF0..SOF15, excluding DHT (C4), JPG (C8) and DAC (CC) which share the range.
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function ascii(buffer: Buffer, start: number, length: number): string {
  return buffer.toString('latin1', start, start + length);
}
