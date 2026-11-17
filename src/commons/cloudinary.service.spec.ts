import { BadRequestException } from '@nestjs/common';
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

  beforeEach(() => {
    end.mockReset();
    uploadStream.mockReset().mockImplementation((_options, callback) => ({
      end: (buffer: Buffer) => {
        end(buffer);
        callback(undefined, { secure_url: 'https://cdn.test/x.png', public_id: 'x' });
      },
    }));
    const config = { getOrThrow: jest.fn().mockReturnValue('configured') } as unknown as ConfigService;
    const logger = { error: jest.fn() } as unknown as LoggerService;
    service = new CloudinaryService(logger, config);
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
});
