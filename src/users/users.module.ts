import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersResolver } from './users.resolver';
import { CommonsModule } from '../commons/commons.module';
import { HashingService } from '../iam/hashing/hashing.service';
import { BcryptService } from '../iam/hashing/bcrypt.service';
import { UsersRepository } from './users.repository';

@Module({
  imports: [CommonsModule],
  providers: [UsersResolver, UsersService, UsersRepository, { provide: HashingService, useClass: BcryptService }],
  exports: [UsersService, UsersRepository],
})
export class UsersModule {}
