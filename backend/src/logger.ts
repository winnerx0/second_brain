import { createLogger, format, transports } from 'winston';

export const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.errors({ stack: true }),
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.colorize(),
    format.printf((info) => {
      const { level, message, timestamp, stack } = info as {
        level: string;
        message: unknown;
        timestamp: string;
        stack?: string;
      };
      const cause = (info as { cause?: unknown }).cause;
      const causeText =
        cause instanceof Error
          ? `\nCaused by: ${cause.stack ?? cause.message}`
          : cause !== undefined
            ? `\nCaused by: ${typeof cause === 'string' ? cause : JSON.stringify(cause)}`
            : '';
      const base = stack
        ? `${timestamp} ${level}: ${message}\n${stack}`
        : `${timestamp} ${level}: ${message}`;
      return `${base}${causeText}`;
    }),
  ),
  transports: [new transports.Console()],
});
