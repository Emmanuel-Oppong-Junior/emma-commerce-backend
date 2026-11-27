import { BadRequestException, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryService } from './cloudinary.service';
import { LoggerService } from './logger.service';

jest.mock('cloudinary', () => ({
  v2: { config: jest.fn(), uploader: { upload_stream: jest.fn() } },
}));

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('CloudinaryService.uploadImage', () => {
  const uploadStream = cloudinary.uploader.upload_stream as jest.Mock;
  const end = jest.fn();
  let service: CloudinaryService;
  let logger: { error: jest.Mock };

  beforeEach(() => {
    end.mockReset();
    uploadStream.mockReset().mockImplementation((_options, callback) => ({
      end: (buffer: Buffer) => {
        end(buffer);
        callback(undefined, { secure_url: 'https://cdn.test/x.png', public_id: 'x' });
      },
    }));
    const config = { getOrThrow: jest.fn().mockReturnValue('configured') } as unknown as ConfigService;
    logger = { error: jest.fn() };
    service = new CloudinaryService(logger as unknown as LoggerService, config);
  });

  const file = (buffer: Buffer) => ({ buffer, originalname: 'x.png' }) as Express.Multer.File;

  it('uploads the resized image as an image resource restricted to raster formats', async () => {
    await service.uploadImage(file(ONE_PIXEL_PNG), 'ecommerce');

    expect(uploadStream).toHaveBeenCalledWith(
      { folder: 'ecommerce', resource_type: 'image', allowed_formats: ['jpg', 'png', 'webp'] },
      expect.any(Function),
    );
    expect(end).toHaveBeenCalledWith(expect.any(Buffer));
    expect(end.mock.calls[0][0]).not.toBe(ONE_PIXEL_PNG);
  });

  it('rejects with 400 and uploads nothing when the image cannot be decoded', async () => {
    const corrupt = Buffer.concat([ONE_PIXEL_PNG.subarray(0, 30), Buffer.from('garbage')]);

    await expect(service.uploadImage(file(corrupt), 'ecommerce')).rejects.toThrow(BadRequestException);
    expect(uploadStream).not.toHaveBeenCalled();
  });

  // Cloudinary's upload callback hands over a plain object, not an Error.
  const failUpload = (error: Record<string, unknown>) =>
    uploadStream.mockImplementation((_options, callback) => ({ end: () => callback(error, undefined) }));

  it('answers 400 when Cloudinary refuses the file', async () => {
    failUpload({ message: 'Image file format bmp not allowed', name: 'Error', http_code: 400 });

    const upload = service.uploadImage(file(ONE_PIXEL_PNG), 'ecommerce');

    await expect(upload).rejects.toThrow(BadRequestException);
    await expect(upload).rejects.toThrow('File "x.png" was refused by the image storage');
    expect(logger.error.mock.calls[0][0]).toContain('Image file format bmp not allowed');
  });

  it.each([
    ['rejected credentials', { message: 'Invalid api_key 1234', name: 'Error', http_code: 401 }],
    ['a rate limit', { message: 'Rate Limit Exceeded', name: 'Error', http_code: 420 }],
    ['a server error', { message: 'Server error', name: 'Error', http_code: 500 }],
    ['no status', { message: 'socket hang up', name: 'Error' }],
  ])('answers 503 without the provider message on %s', async (_case, error) => {
    failUpload(error);

    const failure = await service.uploadImage(file(ONE_PIXEL_PNG), 'ecommerce').catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    const unavailable = failure as ServiceUnavailableException;
    expect(unavailable.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(unavailable.getResponse()).toEqual({
      message: 'Image upload is unavailable, try again later',
      extensions: { reason: 'IMAGE_STORAGE_UNAVAILABLE' },
    });
    expect(logger.error.mock.calls[0][0]).toContain(error.message);
  });
});
