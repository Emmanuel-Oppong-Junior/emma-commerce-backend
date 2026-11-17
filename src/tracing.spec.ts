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
  it('imports tracing before anything else', () => {
    const source = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    const firstImport = source.split('\n').find((line) => line.startsWith('import '));

    expect(firstImport).toBe("import { tracingSdk } from './tracing';");
  });
});
