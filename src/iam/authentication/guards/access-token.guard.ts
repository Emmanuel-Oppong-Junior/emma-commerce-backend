import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import jwtConfig from '../../config/jwt.config';
import { ConfigType } from '@nestjs/config';
import { Request } from 'express';
import { REQUEST_USER_KEY } from '../../iam.constants';
import { UsersService } from '../../../users/users.service';
import { getRequest } from '../../../commons/request-context';

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    @Inject(jwtConfig.KEY)
    private readonly jwtConfiguration: ConfigType<typeof jwtConfig>,
    private readonly userService: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = getRequest(context);
    const token = this.extractTokenFromHeader(request);
    if (!token) throw new UnauthorizedException();
    try {
      const authenticatedUser = await this.jwtService.verifyAsync(token, this.jwtConfiguration);
      const id = authenticatedUser.sub;
      const user = await this.userService.findOne(id);
      if (!user || !user.isActive) throw new UnauthorizedException();
      request[REQUEST_USER_KEY] = user;
    } catch (e) {
      throw new UnauthorizedException();
    }
    return true;
  }

  private extractTokenFromHeader(request: Request) {
    const [, token] = request.headers.authorization?.split(' ') ?? [];
    return token;
  }
}
