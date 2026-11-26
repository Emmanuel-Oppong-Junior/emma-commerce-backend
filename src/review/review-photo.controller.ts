import { BadRequestException, Controller, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { CloudinaryService } from '../commons/cloudinary.service';
import { assertAllowedImage, MAX_IMAGE_FILE_SIZE_BYTES } from '../commons/image-upload-validation';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { CustomerOnly } from '../iam/authorization/policy.decorators';
import { ReviewService } from './review.service';
import { reviewPhotoFolder } from './review-rules';
import { RequireFeature } from '../store-features/require-feature';

const multerOptions = { storage: memoryStorage(), limits: { fileSize: MAX_IMAGE_FILE_SIZE_BYTES } };

export interface UploadedReviewPhoto {
  id: string;
  url: string;
}

/**
 * Review photos (P6-V.1): a JPEG, PNG or WebP (checked by its bytes, at most 5 MB) added to the caller's own review,
 * stored in its Cloudinary folder; a review holds at most MAX_REVIEW_PHOTOS.
 */
@Auth(AuthType.Bearer)
@CustomerOnly()
@Controller('reviews')
export class ReviewPhotoController {
  constructor(
    private readonly cloudinary: CloudinaryService,
    private readonly reviewService: ReviewService,
  ) {}

  @Throttle({ upload: { limit: 10, ttl: 60000 } })
  @RequireFeature('REVIEWS')
  @Post(':reviewId/photos')
  @UseInterceptors(FileInterceptor('file', multerOptions))
  async uploadReviewPhoto(
    @ActiveUser('id') userId: string,
    @Param('reviewId') reviewId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<UploadedReviewPhoto> {
    if (!file) throw new BadRequestException('No file was uploaded (field "file")');
    assertAllowedImage(file.buffer, file.originalname);
    await this.reviewService.assertCanAddPhoto(userId, reviewId);
    const result = (await this.cloudinary.uploadImage(file, reviewPhotoFolder(reviewId))) as Record<string, unknown>;
    const photo = await this.reviewService.attachPhoto(userId, reviewId, {
      publicId: String(result['public_id']),
      url: String(result['secure_url']),
    });
    return { id: photo.id, url: photo.url };
  }
}
