import { Test, TestingModule } from '@nestjs/testing';
import { GoogleAuthenticationService } from './google-authentication.service';
import { ConfigService } from '@nestjs/config';
import { AuthenticationService } from '../authentication.service';
import { UsersService } from '../../../users/users.service';

describe('GoogleAuthenticationService', () => {
  let service: GoogleAuthenticationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoogleAuthenticationService,
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: AuthenticationService, useValue: {} },
        { provide: UsersService, useValue: {} },
      ],
    }).compile();

    service = module.get<GoogleAuthenticationService>(GoogleAuthenticationService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
