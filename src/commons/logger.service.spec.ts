import { Test, TestingModule } from '@nestjs/testing';
import { transports as winstonTransports } from 'winston';
import { consoleFormat, LoggerService, logTransports } from './logger.service';
import { ConfigService } from '@nestjs/config';
import { runWithCorrelation } from './correlation';

// winston's (triple-beam's) keys for the record's level and its rendered line.
const LEVEL = Symbol.for('level');
const MESSAGE = Symbol.for('message');

describe('LoggerService', () => {
  let service: LoggerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [LoggerService, { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('test') } }],
    }).compile();

    service = module.get<LoggerService>(LoggerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

const render = (nodeEnv: string, info: Record<string, unknown>): string => {
  const record = { level: 'info', [LEVEL]: 'info', ...info };
  const formatted = consoleFormat(nodeEnv).transform(record as never, {}) as unknown as Record<symbol, unknown>;
  return formatted[MESSAGE] as string;
};

describe('log format', () => {
  it.each(['production', 'test'])('writes one line of JSON in %s with an ISO UTC timestamp', (nodeEnv) => {
    const line = render(nodeEnv, { message: 'Order placed', context: 'OrderService', orderId: 'order_1' });

    expect(line).not.toContain('\n');
    const record = JSON.parse(line);
    expect(record).toMatchObject({
      level: 'info',
      message: 'Order placed',
      context: 'OrderService',
      orderId: 'order_1',
    });
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('adds the running request id and authenticated user to every record', () => {
    const request = { user: { id: 'user-1' } };
    const line = runWithCorrelation({ requestId: 'req-1', request }, () =>
      render('production', { message: 'Cart updated', context: 'CartService' }),
    );

    expect(JSON.parse(line)).toMatchObject({ requestId: 'req-1', userId: 'user-1' });
  });

  it('adds the job id and queue inside a job, and lets explicit fields win', () => {
    const line = runWithCorrelation({ requestId: 'req-1', jobId: 'job-1', queue: 'webhooks' }, () =>
      render('production', { message: 'Webhook processed', requestId: 'req-explicit' }),
    );

    expect(JSON.parse(line)).toMatchObject({ requestId: 'req-explicit', jobId: 'job-1', queue: 'webhooks' });
  });

  it('carries no correlation fields outside a request', () => {
    const record = JSON.parse(render('production', { message: 'Application running' }));

    expect(record).not.toHaveProperty('requestId');
    expect(record).not.toHaveProperty('userId');
  });

  it('stays readable text in development', () => {
    const line = runWithCorrelation({ requestId: 'req-1' }, () =>
      render('development', { message: 'Order placed', context: 'OrderService' }),
    );

    expect(line).toContain('[OrderService] Order placed rid:req-1');
    expect(() => JSON.parse(line)).toThrow();
  });
});

describe('log transports', () => {
  it.each(['production', 'test'])('write to the console only in %s (no files on container disk)', (nodeEnv) => {
    const transports = logTransports(nodeEnv);

    expect(transports).toHaveLength(1);
    expect(transports[0]).toBeInstanceOf(winstonTransports.Console);
  });

  it('add rotated local files in development', () => {
    const transports = logTransports('development');

    expect(transports).toHaveLength(3);
    expect(transports.filter((transport) => transport instanceof winstonTransports.DailyRotateFile)).toHaveLength(2);
    transports.forEach((transport) => transport.close?.());
  });
});
