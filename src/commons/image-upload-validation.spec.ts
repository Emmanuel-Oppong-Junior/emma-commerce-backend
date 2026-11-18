import { BadRequestException } from '@nestjs/common';
import { sharp } from './sharp';
import { assertAllowedImage, MAX_IMAGE_FILE_SIZE_BYTES, MAX_IMAGE_PIXELS } from './image-upload-validation';

const solidImage = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 10, b: 10 } } });

function pngHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.alloc(18);
  app0.writeUInt16BE(0xffe0, 0);
  app0.writeUInt16BE(16, 2);
  app0.write('JFIF', 4, 'latin1');
  const sof0 = Buffer.alloc(19);
  sof0.writeUInt16BE(0xffc0, 0);
  sof0.writeUInt16BE(17, 2);
  sof0[4] = 8;
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]);
}

function webpVp8xHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(30);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(22, 4);
  header.write('WEBP', 8, 'latin1');
  header.write('VP8X', 12, 'latin1');
  header.writeUInt32LE(10, 16);
  header.writeUIntLE(width - 1, 24, 3);
  header.writeUIntLE(height - 1, 27, 3);
  return header;
}

const expectRejection = (buffer: Buffer, message: string | RegExp) => {
  expect(() => assertAllowedImage(buffer, 'upload.bin')).toThrow(BadRequestException);
  expect(() => assertAllowedImage(buffer, 'upload.bin')).toThrow(message);
};

describe('assertAllowedImage', () => {
  it.each([
    ['jpeg', () => solidImage(123, 45).jpeg().toBuffer()],
    ['png', () => solidImage(123, 45).png().toBuffer()],
    ['webp', () => solidImage(123, 45).webp().toBuffer()],
    ['webp', () => solidImage(123, 45).webp({ lossless: true }).toBuffer()],
  ])('accepts a real %s image', async (format, encode) => {
    const buffer = await encode();

    expect(assertAllowedImage(buffer, 'photo')).toBe(format);
  });

  it('reads JPEG dimensions past APP segments and rejects an over-limit image', () => {
    expect(assertAllowedImage(jpegHeader(4000, 3000), 'photo.jpg')).toBe('jpeg');
    expectRejection(jpegHeader(65535, 65535), /65535x65535.*limit is 40000000 pixels/);
  });

  it('rejects a PNG whose header declares more pixels than the limit (decompression bomb)', () => {
    expect(assertAllowedImage(pngHeader(8000, 5000), 'big.png')).toBe('png');
    expectRejection(pngHeader(8000, 5001), `limit is ${MAX_IMAGE_PIXELS} pixels`);
  });

  it('rejects a WebP whose canvas exceeds the pixel limit', () => {
    expect(assertAllowedImage(webpVp8xHeader(6000, 6000), 'a.webp')).toBe('webp');
    expectRejection(webpVp8xHeader(16383, 16383), /16383x16383/);
  });

  it.each([
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ['PDF', Buffer.from('%PDF-1.7\n')],
    ['GIF', Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00])],
    ['HTML', Buffer.from('<!doctype html><html></html>')],
    ['empty', Buffer.alloc(0)],
  ])('rejects %s content regardless of the claimed name or mimetype', (_label, buffer) => {
    expectRejection(buffer, 'is not a JPEG, PNG or WebP image');
  });

  it('rejects a signature with a truncated or corrupt header', () => {
    expectRejection(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'unreadable jpeg header');
    expectRejection(pngHeader(10, 10).subarray(0, 20), 'unreadable png header');
    expectRejection(pngHeader(0, 10), 'unreadable png header');
  });

  it('rejects a file larger than the size cap', () => {
    const oversized = Buffer.concat([pngHeader(10, 10), Buffer.alloc(MAX_IMAGE_FILE_SIZE_BYTES)]);

    expectRejection(oversized, `the limit is ${MAX_IMAGE_FILE_SIZE_BYTES} bytes`);
  });
});
