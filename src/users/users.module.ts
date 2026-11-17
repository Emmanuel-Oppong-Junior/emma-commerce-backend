import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersResolver } from './users.resolver';
import { CommonsModule } from '../commons/commons.module';
import { HashingService } from '../iam/hashing/hashing.service';
import { BcryptService } from '../iam/hashing/bcrypt.service';
import { UsersRepository } from './users.repository';
import { AddressesLoader } from './loaders/addresses.loader';
import { OrdersLoader } from './loaders/orders.loader';
import { UsersLoader } from './loaders/users.loader';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailVerificationService } from './email-verification.service';

@Module({
  imports: [CommonsModule, PrismaModule, NotificationsModule],
  providers: [
    UsersResolver,
    UsersService,
    UsersRepository,
    EmailVerificationService,
    { provide: HashingService, useClass: BcryptService },
    AddressesLoader,
    OrdersLoader,
    UsersLoader,
  ],
  exports: [UsersService, UsersRepository, UsersLoader, EmailVerificationService],
})
export class UsersModule {}
