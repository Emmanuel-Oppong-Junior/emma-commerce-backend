import {
  BadRequestException,
  Controller,
  NotFoundException,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { CloudinaryService } from '../commons/cloudinary.service';
import { assertAllowedImage, MAX_IMAGE_FILE_SIZE_BYTES } from '../commons/image-upload-validation';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { CustomerOnly } from '../iam/authorization/policy.decorators';
import { PrismaService } from '../prisma/prisma.service';
import { returnPhotoFolder } from './return-rules';

const multerOptions = { storage: memoryStorage(), limits: { fileSize: MAX_IMAGE_FILE_SIZE_BYTES } };

export interface ReturnPhoto {
  publicId: string;
  url: string;
}

/**
 * Photos for a return (P6-R.1): a JPEG, PNG or WebP (checked by its bytes, at most 5 MB) uploaded into the order's
 * Cloudinary folder by its customer; the publicId then goes on a line of requestReturn, which accepts only photos of
 * that order.
 */
@Controller('returns')
export class ReturnPhotoController {
  constructor(
    private readonly cloudinary: CloudinaryService,
    private readonly prisma: PrismaService,
  ) {}

  @CustomerOnly()
  @Throttle({ upload: { limit: 10, ttl: 60000 } })
  @Post('orders/:orderId/photos')
  @UseInterceptors(FileInterceptor('file', multerOptions))
  async uploadReturnPhoto(
    @ActiveUser('id') userId: string,
    @Param('orderId') orderId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<ReturnPhoto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { userId: true, deleted: true },
    });
    if (!order || order.deleted || order.userId !== userId) throw new NotFoundException(`Order "${orderId}" not found`);
    if (!file) throw new BadRequestException('No file was uploaded (field "file")');
    assertAllowedImage(file.buffer, file.originalname);
    const result = (await this.cloudinary.uploadImage(file, returnPhotoFolder(orderId))) as Record<string, unknown>;
    return { publicId: String(result['public_id']), url: String(result['secure_url']) };
  }
}
