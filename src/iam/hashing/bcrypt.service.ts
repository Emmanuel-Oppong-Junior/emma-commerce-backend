import { Injectable } from '@nestjs/common';
import { HashingService } from './hashing.service';
import { compare, genSalt, hash } from 'bcrypt';

@Injectable()
export class BcryptService extends HashingService {
  /**
   * Compares a given data string or buffer with an encrypted string to determine if they match.
   *
   * @param data - The plain data to compare, which can be a string or a Buffer.
   * @param encrypted - The encrypted string to compare against.
   * @returns A promise that resolves to a boolean indicating whether the data matches the encrypted string.
   */
  compare(data: string | Buffer, encrypted: string): Promise<boolean> {
    return compare(data, encrypted);
  }

  async hash(data: string | Buffer): Promise<string> {
    // [HIGH-4] Explicitly use 12 rounds — default (10) is below current best-practice minimum
    const salt = await genSalt(12);
    return hash(data, salt);
  }
}
