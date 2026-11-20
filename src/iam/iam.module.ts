import { Module } from '@nestjs/common';
import { AuthenticationService } from './authentication/authentication.service';
import { BcryptService } from './hashing/bcrypt.service';
import { HashingService } from './hashing/hashing.service';
import { JwtModule } from '@nestjs/jwt';
import jwtConfig from './config/jwt.config';
import { UsersModule } from '../users/users.module';
import { ConfigModule } from '@nestjs/config';
import { AuthenticationResolver } from './authentication/authentication.resolver';
import { GoogleAuthenticationService } from './authentication/social/google-authentication.service';
import { FacebookAuthenticationService } from './authentication/social/facebook-authentication.service';
import { APP_GUARD } from '@nestjs/core';
import { AccessTokenGuard } from './authentication/guards/access-token.guard';
import { AuthenticationGuard } from './authentication/guards/authentication.guard';
import { AuthorizationGuard } from './authorization/authorization.guard';
import { NotificationsModule } from '../notifications/notifications.module';
import { CommonsModule } from '../commons/commons.module';

@Module({
  imports: [
    JwtModule.registerAsync(jwtConfig.asProvider()),
    UsersModule,
    ConfigModule.forFeature(jwtConfig),
    NotificationsModule,
    CommonsModule,
  ],
  providers: [
    AuthenticationService,
    { provide: HashingService, useClass: BcryptService },
    AuthenticationResolver,
    GoogleAuthenticationService,
    FacebookAuthenticationService,
    AccessTokenGuard,
    {
      provide: APP_GUARD,
      useClass: AuthenticationGuard,
    },
    {
      provide: APP_GUARD,
      useClass: AuthorizationGuard,
    },
  ],
  controllers: [],
})
export class IamModule {}
// Note: UsersRepository is exported from UsersModule and injected into AuthenticationService.
