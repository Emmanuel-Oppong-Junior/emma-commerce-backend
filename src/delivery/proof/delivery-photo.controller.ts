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
import { CloudinaryService } from '../../commons/cloudinary.service';
import { assertAllowedImage, MAX_IMAGE_FILE_SIZE_BYTES } from '../../commons/image-upload-validation';
import { ActiveUser } from '../../iam/authentication/decorators/active-user.decorator';
import { RequirePermission } from '../../iam/authorization/policy.decorators';
import { ShipmentsRepository } from '../../order/shipments.repository';
import { deliveryPhotoFolder } from './proof-of-delivery';

const multerOptions = { storage: memoryStorage(), limits: { fileSize: MAX_IMAGE_FILE_SIZE_BYTES } };

export interface DeliveryPhoto {
  publicId: string;
  url: string;
}

/**
 * Delivery photos (P5-C.2): a JPEG, PNG or WebP (checked by its bytes, at most 5 MB) uploaded into the shipment's
 * Cloudinary folder; its publicId then goes into completeMyDelivery / completeDelivery, which accept only photos of
 * that shipment.
 */
@Controller('delivery')
export class DeliveryPhotoController {
  constructor(
    private readonly cloudinary: CloudinaryService,
    private readonly shipmentsRepository: ShipmentsRepository,
  ) {}

  @RequirePermission('delivery.ride')
  @Throttle({ upload: { limit: 10, ttl: 60000 } })
  @Post('my-shipments/:shipmentId/photo')
  @UseInterceptors(FileInterceptor('file', multerOptions))
  async uploadMyDeliveryPhoto(
    @ActiveUser('id') riderId: string,
    @Param('shipmentId') shipmentId: string,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<DeliveryPhoto> {
    if ((await this.shipmentsRepository.findRiderId(shipmentId)) !== riderId) {
      throw new NotFoundException(`Shipment "${shipmentId}" not found`);
    }
    return this.upload(shipmentId, file);
  }

  @RequirePermission('order.fulfil')
  @Throttle({ upload: { limit: 10, ttl: 60000 } })
  @Post('shipments/:shipmentId/photo')
  @UseInterceptors(FileInterceptor('file', multerOptions))
  async uploadDeliveryPhoto(
    @Param('shipmentId') shipmentId: string,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<DeliveryPhoto> {
    if (!(await this.shipmentsRepository.exists(shipmentId))) {
      throw new NotFoundException(`Shipment "${shipmentId}" not found`);
    }
    return this.upload(shipmentId, file);
  }

  private async upload(shipmentId: string, file: Express.Multer.File | undefined): Promise<DeliveryPhoto> {
    if (!file) throw new BadRequestException('No file was uploaded (field "file")');
    assertAllowedImage(file.buffer, file.originalname);
    const result = (await this.cloudinary.uploadImage(file, deliveryPhotoFolder(shipmentId))) as Record<
      string,
      unknown
    >;
    return { publicId: String(result['public_id']), url: String(result['secure_url']) };
  }
}
