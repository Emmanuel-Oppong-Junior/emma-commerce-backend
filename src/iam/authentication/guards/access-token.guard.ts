import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import jwtConfig from '../../config/jwt.config';
import { ConfigType } from '@nestjs/config';
import { Request } from 'express';
import { REQUEST_USER_KEY } from '../../iam.constants';
import { UsersService } from '../../../users/users.service';
import { getRequest } from '../../../commons/request-context';
import { staffAccessFor } from '../../authorization/staff-access';

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
      const found = await this.userService.findWithStaffRole(id);
      if (!found || !found.isActive) throw new UnauthorizedException();
      const { storeMemberships, ...user } = found;
      request[REQUEST_USER_KEY] = user;
      request.access = staffAccessFor(storeMemberships[0]?.role);
    } catch {
      throw new UnauthorizedException();
    }
    return true;
  }

  private extractTokenFromHeader(request: Request) {
    const [, token] = request.headers.authorization?.split(' ') ?? [];
    return token;
  }
}
