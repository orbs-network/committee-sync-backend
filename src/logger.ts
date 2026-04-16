import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';

/**
 * Initializes file logging: mirrors all console output to a timestamped file
 * under logs/, while preserving normal terminal output.
 *
 * Call this once at the very top of the entry point, before any other code
 * logs anything. Safe under any launch method (npm start, F5 debug, scripts).
 */
export function initFileLogging(): string {
  const logsDir = path.join(process.cwd(), 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  // ISO-ish timestamp without colons (filesystem-friendly, sorts naturally)
  const ts = new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace(/:/g, '-');
  const logFile = path.join(logsDir, `${ts}.log`);

  const stream = fs.createWriteStream(logFile, { flags: 'a' });

  const format = (args: unknown[]): string =>
    args
      .map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: null, colors: false })))
      .join(' ');

  const wrap = (level: 'log' | 'info' | 'warn' | 'error' | 'debug') => {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      stream.write(`[${new Date().toISOString()}] [${level}] ${format(args)}\n`);
    };
  };

  (['log', 'info', 'warn', 'error', 'debug'] as const).forEach(wrap);

  const flushAndExit = () => {
    try {
      stream.end();
    } catch {
      // ignore
    }
  };
  process.on('exit', flushAndExit);
  process.on('SIGINT', flushAndExit);
  process.on('SIGTERM', flushAndExit);

  console.log(`File logging initialized: ${logFile}`);
  return logFile;
}
