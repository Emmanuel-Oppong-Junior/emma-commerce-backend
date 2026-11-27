import { BadRequestException, HttpStatus, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { sharp } from './sharp';
import { LoggerService } from './logger.service';
import { MAX_IMAGE_PIXELS } from './image-upload-validation';
import { describeErrorForLog } from './filters/error-classification';

export const IMAGE_STORAGE_UNAVAILABLE = 'IMAGE_STORAGE_UNAVAILABLE';

@Injectable()
export class CloudinaryService {
  constructor(
    private readonly logger: LoggerService,
    private readonly configService: ConfigService,
  ) {
    cloudinary.config({
      cloud_name: this.configService.getOrThrow<string>('CLOUDINARY_CLOUD_NAME'),
      api_key: this.configService.getOrThrow<string>('CLOUDINARY_API_KEY'),
      api_secret: this.configService.getOrThrow<string>('CLOUDINARY_API_SECRET'),
    });
  }

  /**
   * Resizes the given image to 500×500 and uploads it to the specified Cloudinary folder.
   * @param file - The multipart file to upload.
   * @param folder - The Cloudinary folder path to upload into.
   * @returns The Cloudinary upload result containing the public URL and asset metadata.
   */
  async uploadImage(file: Express.Multer.File, folder: string) {
    let resizedBuffer: Buffer;
    try {
      resizedBuffer = await this.resizeImageBuffer(file.buffer);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error('Error resizing image', reason);
      throw new BadRequestException(`File "${file.originalname}" could not be decoded as an image: ${reason}`);
    }

    return new Promise((resolve, reject) => {
      cloudinary.uploader
        .upload_stream({ folder, resource_type: 'image', allowed_formats: ['jpg', 'png', 'webp'] }, (error, result) => {
          if (error) return reject(this.uploadFailure(error, file.originalname));
          resolve(result);
        })
        .end(resizedBuffer);
    });
  }

  // Cloudinary calls back with a plain { message, name, http_code } object. Only its 400 is about the file; every other
  // failure (credentials, rate limit, outage) is ours, and its message may name the account, so it stays in the log.
  private uploadFailure(error: { http_code?: number }, filename: string): Error {
    const status = error.http_code;
    this.logger.error(
      `Cloudinary upload failed | http_code: ${status ?? 'none'} | ${describeErrorForLog(error)}`,
      undefined,
      'CloudinaryService',
    );
    if (status === HttpStatus.BAD_REQUEST) {
      return new BadRequestException(
        `File "${filename}" was refused by the image storage: upload a JPEG, PNG or WebP image`,
      );
    }
    return new ServiceUnavailableException({
      message: 'Image upload is unavailable, try again later',
      extensions: { reason: IMAGE_STORAGE_UNAVAILABLE },
    });
  }

  /** The HTTPS delivery URL of an uploaded image, built from its public id (no API call). */
  urlFor(publicId: string): string {
    return cloudinary.url(publicId, { secure: true, resource_type: 'image' });
  }

  private resizeImageBuffer(buffer: Buffer): Promise<Buffer> {
    return sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS })
      .resize(500, 500, {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .toBuffer();
  }
}
