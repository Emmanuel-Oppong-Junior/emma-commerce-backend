import { Injectable } from '@nestjs/common';
import { v2 as cloudinary } from 'cloudinary';
import * as sharp from 'sharp';
import { LoggerService } from './logger.service';
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUD_API_KEY,
  api_secret: process.env.CLOUD_SECRET,
});

@Injectable()
export class CloudinaryService {
  constructor(private readonly logger: LoggerService) {}
  async uploadImage(file: Express.Multer.File, folder: string) {
    let resizedBuffer = file.buffer;
    try {
      resizedBuffer = await this.resizeImageBuffer(file.buffer);
    } catch (error) {
      this.logger.error('Error resizing image', error);
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
