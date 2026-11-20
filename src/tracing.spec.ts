import { readFileSync } from 'fs';
import { join } from 'path';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { startTracing } from './tracing';

describe('startTracing', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([{}, { OTEL_ENABLED: 'false' }, { OTEL_ENABLED: 'TRUE' }])('does nothing when env is %j', (env) => {
    const start = jest.spyOn(NodeSDK.prototype, 'start');

    expect(startTracing(env)).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
  });

  it('starts the SDK when OTEL_ENABLED is "true"', () => {
    const start = jest.spyOn(NodeSDK.prototype, 'start').mockImplementation(() => undefined);

    const sdk = startTracing({ OTEL_ENABLED: 'true' });

    expect(sdk).toBeInstanceOf(NodeSDK);
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe('main.ts', () => {
  // Auto-instrumentation only patches modules (http, express, pg) required after the SDK starts.
  it('imports tracing (through src/instrument.ts) before anything else', () => {
    const source = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    const firstImport = source.split('\n').find((line) => line.startsWith('import '));

    expect(firstImport).toBe("import { tracingSdk } from './instrument';");
  });

  it('starts Sentry, then tracing, from src/instrument.ts, which loads neither Nest, Express nor Prisma', () => {
    const source = readFileSync(join(__dirname, 'instrument.ts'), 'utf8');
    const imports = source.split('\n').filter((line) => line.startsWith('import '));

    expect(imports).toEqual([
      "import { initSentry } from './observability/sentry';",
      "import { startTracing } from './tracing';",
    ]);
    expect(source.indexOf('initSentry(process.env)')).toBeLessThan(source.indexOf('startTracing(process.env)'));
  });
});
