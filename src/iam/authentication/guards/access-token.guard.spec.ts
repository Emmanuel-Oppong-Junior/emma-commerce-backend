import { Test, TestingModule } from '@nestjs/testing';
import { AccessTokenGuard } from './access-token.guard';
import { JwtService } from '@nestjs/jwt';
import jwtConfig from '../../config/jwt.config';
import { UsersService } from '../../../users/users.service';

describe('AccessTokenGuard', () => {
  let guard: AccessTokenGuard;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccessTokenGuard,
        { provide: JwtService, useValue: {} },
        { provide: jwtConfig.KEY, useValue: {} },
        { provide: UsersService, useValue: {} },
      ],
    }).compile();

    guard = module.get<AccessTokenGuard>(AccessTokenGuard);
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });
});
