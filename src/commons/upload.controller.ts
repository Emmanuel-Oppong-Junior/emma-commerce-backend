import { BadRequestException, Controller, Post, UploadedFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { Role } from '../generated/prisma/client';
import { CloudinaryService } from './cloudinary.service';
import { memoryStorage } from 'multer';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { Roles } from '../iam/authentication/decorators/roles.decorator';
import { assertAllowedImage, MAX_IMAGE_FILE_SIZE_BYTES } from './image-upload-validation';

const multerOptions = {
  storage: memoryStorage(),
  limits: { fileSize: MAX_IMAGE_FILE_SIZE_BYTES },
};

@Auth(AuthType.Bearer)
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@Controller('upload')
export class UploadController {
  constructor(private readonly cloudinaryService: CloudinaryService) {}
  @Throttle({ upload: { limit: 10, ttl: 60000 } })
  @Post('/multiple-images')
  @UseInterceptors(FilesInterceptor('files', 3, multerOptions))
  async uploadProductImages(@UploadedFiles() images: Express.Multer.File[]) {
    if (!images || images.length === 0) {
      throw new BadRequestException('No files were uploaded');
    }
    images.forEach((file) => assertAllowedImage(file.buffer, file.originalname));
    const uploadedFiles = await Promise.all(
      images.map((file) => this.cloudinaryService.uploadImage(file, 'ecommerce')),
    );
    return {
      message: 'Product images uploaded successfully',
      files: uploadedFiles.map((f) => {
        const r = f as Record<string, unknown>;
        return { url: r['secure_url'], public_id: r['public_id'] };
      }),
    };
  }

  @Throttle({ upload: { limit: 10, ttl: 60000 } })
  @Post('/single-image')
  @UseInterceptors(FileInterceptor('file', multerOptions))
  async uploadCategoryImage(@UploadedFile() image: Express.Multer.File) {
    if (!image) {
      throw new BadRequestException('No file was uploaded');
    }
    assertAllowedImage(image.buffer, image.originalname);
    const result = await this.cloudinaryService.uploadImage(image, 'ecommerce');
    const r = result as Record<string, unknown>;
    return { url: r['secure_url'], public_id: r['public_id'] };
  }
}
