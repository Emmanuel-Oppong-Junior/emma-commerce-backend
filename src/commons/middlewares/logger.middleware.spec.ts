import { LoggerMiddleware } from './logger.middleware';
import { LoggerService } from '../logger.service';

describe('LoggerMiddleware', () => {
  it('should be defined', () => {
    const mockLogger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as LoggerService;
    expect(new LoggerMiddleware(mockLogger)).toBeDefined();
  });
});
