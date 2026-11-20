import { createServer } from 'node:net';
import { once } from 'node:events';

/** A TCP port that was free a moment ago (the OS picks it), for a test's metrics server. */
export async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  server.close();
  await once(server, 'close');
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');
  return address.port;
}

export interface MetricSample {
  labels: Record<string, string>;
  value: number;
}

const LABEL = /(\w+)="((?:[^"\\]|\\.)*)"/g;

/** The samples of one metric in Prometheus text output, with their labels parsed. */
export function samplesOf(text: string, metric: string): MetricSample[] {
  return text.split('\n').flatMap((row) => {
    const hasLabels = row.startsWith(`${metric}{`);
    if (!hasLabels && !row.startsWith(`${metric} `)) return [];
    const valueStart = hasLabels ? row.lastIndexOf('}') + 1 : metric.length;
    const labelText = hasLabels ? row.slice(metric.length + 1, valueStart - 1) : '';
    const labels = Object.fromEntries([...labelText.matchAll(LABEL)].map(([, name, value]) => [name, value]));
    const value = Number(row.slice(valueStart).trim().split(' ')[0]);
    return [{ labels, value }];
  });
}

/** The Prometheus text served on `port`, as the scraper sees it. */
export async function scrapeMetrics(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/metrics`);
  if (!response.ok) throw new Error(`GET /metrics answered ${response.status}`);
  return response.text();
}
