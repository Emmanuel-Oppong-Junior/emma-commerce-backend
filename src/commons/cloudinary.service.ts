import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import * as sharp from 'sharp';
import { LoggerService } from './logger.service';

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
    let resizedBuffer = file.buffer;
    try {
      resizedBuffer = await this.resizeImageBuffer(file.buffer);
    } catch (error) {
      this.logger.error('Error resizing image', error instanceof Error ? error.message : String(error));
    }

    return new Promise((resolve, reject) => {
      cloudinary.uploader
        .upload_stream({ folder }, (error, result) => {
          if (error) return reject(error);
          resolve(result);
        })
        .end(resizedBuffer);
    });
  }

  private resizeImageBuffer(buffer: Buffer): Promise<Buffer> {
    return sharp(buffer)
      .resize(500, 500, {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .toBuffer();
  }
}
