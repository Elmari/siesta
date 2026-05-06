import pino from 'pino';

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'warn',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, ignore: 'pid,hostname,time', singleLine: true },
  },
});
