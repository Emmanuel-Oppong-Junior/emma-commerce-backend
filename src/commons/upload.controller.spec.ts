import { BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ROLES_KEY } from '../iam/authentication/decorators/roles.decorator';
import { CloudinaryService } from './cloudinary.service';
import { UploadController } from './upload.controller';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const file = (buffer: Buffer, originalname: string) =>
  ({ buffer, originalname, mimetype: 'image/png', size: buffer.length }) as Express.Multer.File;

describe('UploadController', () => {
  const cloudinary = { uploadImage: jest.fn() };
  const controller = new UploadController(cloudinary as unknown as CloudinaryService);

  beforeEach(() => {
    cloudinary.uploadImage.mockReset().mockResolvedValue({ secure_url: 'https://cdn.test/a.png', public_id: 'a' });
  });

  it.each(['uploadProductImages', 'uploadCategoryImage'] as const)('restricts %s to ADMIN and SUPER_ADMIN', (name) => {
    const roles = new Reflector().getAllAndOverride<Role[]>(ROLES_KEY, [
      UploadController.prototype[name],
      UploadController,
    ]);

    expect(roles).toEqual([Role.ADMIN, Role.SUPER_ADMIN]);
  });

  it('uploads a valid PNG', async () => {
    await expect(controller.uploadCategoryImage(file(ONE_PIXEL_PNG, 'a.png'))).resolves.toEqual({
      url: 'https://cdn.test/a.png',
      public_id: 'a',
    });
  });

  it('rejects an SVG sent as image/png with a .png name before uploading', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

    await expect(controller.uploadCategoryImage(file(svg, 'evil.png'))).rejects.toThrow(BadRequestException);
    expect(cloudinary.uploadImage).not.toHaveBeenCalled();
  });

  it('rejects the whole batch when any file fails validation, uploading none', async () => {
    const batch = [file(ONE_PIXEL_PNG, 'ok.png'), file(Buffer.from('%PDF-1.7'), 'doc.png')];

    await expect(controller.uploadProductImages(batch)).rejects.toThrow(
      'File "doc.png" is not a JPEG, PNG or WebP image',
    );
    expect(cloudinary.uploadImage).not.toHaveBeenCalled();
  });

  it('answers 400 when no file is sent', async () => {
    await expect(controller.uploadCategoryImage(undefined as unknown as Express.Multer.File)).rejects.toThrow(
      BadRequestException,
    );
    await expect(controller.uploadProductImages([])).rejects.toThrow(BadRequestException);
  });
});
