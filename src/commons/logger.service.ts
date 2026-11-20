import { Injectable, LoggerService as NestLoggerService } from '@nestjs/common';
import { createLogger, format, Logger, transport as Transport, transports } from 'winston';
import 'winston-daily-rotate-file';
import { ConfigService } from '@nestjs/config';
import { currentCorrelation } from './correlation';

/** Structured fields added to one log record. Never values that can hold PII or secrets. */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

/** Adds the running request's or job's ids; fields given explicitly on the record win. */
const correlate = format((info) => Object.assign(info, { ...currentCorrelation(), ...info }));

const pretty = format.printf(({ timestamp, level, message, context, requestId, ...fields }) => {
  const extra = Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
  return `${String(timestamp)} ${level} [${String(context ?? '-')}] ${String(message)}${requestId ? ` rid:${String(requestId)}` : ''}${extra}`;
});

/** Single-line JSON with ISO UTC timestamps, except in development where it is coloured text. */
export function consoleFormat(nodeEnv: string | undefined) {
  const base = [correlate(), format.timestamp()];
  return nodeEnv === 'development'
    ? format.combine(...base, format.colorize(), pretty)
    : format.combine(...base, format.json());
}

/** Containers ship stdout; local log files exist only in development. */
export function logTransports(nodeEnv: string | undefined): Transport[] {
  const console = new transports.Console({ format: consoleFormat(nodeEnv) });
  if (nodeEnv !== 'development') return [console];
  const fileFormat = format.combine(correlate(), format.timestamp(), format.json());
  const rotation = {
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '14d',
    format: fileFormat,
  };
  return [
    console,
    new transports.DailyRotateFile({ filename: 'logs/combined-%DATE%.log', ...rotation }),
    new transports.DailyRotateFile({ filename: 'logs/error-%DATE%.log', level: 'error', ...rotation }),
  ];
}

@Injectable()
export class LoggerService implements NestLoggerService {
  private readonly logger: Logger;

  constructor(private readonly configService: ConfigService) {
    this.logger = createLogger({
      level: this.configService.get('LOG_LEVEL') || 'info',
      transports: logTransports(this.configService.get('NODE_ENV')),
    });
  }

  log(message: string, context?: string, fields?: LogFields) {
    this.logger.info(message, { ...fields, context });
  }

  error(message: string, trace?: string, context?: string, fields?: LogFields) {
    this.logger.error(message, { ...fields, trace, context });
  }

  warn(message: string, context?: string, fields?: LogFields) {
    this.logger.warn(message, { ...fields, context });
  }

  debug(message: string, context?: string, fields?: LogFields) {
    this.logger.debug(message, { ...fields, context });
  }

  verbose(message: string, context?: string, fields?: LogFields) {
    this.logger.verbose(message, { ...fields, context });
  }
}
