import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller';
import { LoggerService } from './logger.service';
import { ConfigModule } from '@nestjs/config';
import { CloudinaryService } from './cloudinary.service';
import { AuditService } from './audit.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [UploadController],
  providers: [LoggerService, CloudinaryService, AuditService],
  exports: [LoggerService, AuditService, CloudinaryService],
})
export class CommonsModule {}
