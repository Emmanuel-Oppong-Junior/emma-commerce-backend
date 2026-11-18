import { Test, TestingModule } from '@nestjs/testing';
import { BcryptService } from './bcrypt.service';

describe('BcryptService', () => {
  let service: BcryptService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [BcryptService],
    }).compile();

    service = module.get<BcryptService>(BcryptService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('compare', () => {
    // Made by bcrypt 5.1.1 with genSalt(12): stored passwords must keep verifying across bcrypt upgrades.
    const bcrypt5Hash = '$2b$12$pWvpb5zAaWwQ11UetmNvcOvCwEykKr.Kk0VOxoTqlkxCQj6.mjhIy';

    it('verifies a hash made by an earlier bcrypt major', async () => {
      await expect(service.compare('correct horse battery staple', bcrypt5Hash)).resolves.toBe(true);
    });

    it('rejects the wrong password against that hash', async () => {
      await expect(service.compare('wrong password', bcrypt5Hash)).resolves.toBe(false);
    });
  });

  describe('hash', () => {
    it('produces a $2b$ hash with 12 rounds that verifies', async () => {
      const hashed = await service.hash('correct horse battery staple');

      expect(hashed).toMatch(/^\$2b\$12\$/);
      await expect(service.compare('correct horse battery staple', hashed)).resolves.toBe(true);
    });
  });
});
