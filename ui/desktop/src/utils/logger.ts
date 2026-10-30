import log from 'electron-log';
import path from 'node:path';
import { app } from 'electron';

// Single log root for the desktop app and every goose backend it spawns.
// `GOOSE_LOG_DIR` lets an operator redirect all of them together.
export const LOG_DIR = process.env.GOOSE_LOG_DIR || path.join(app.getPath('userData'), 'logs');

// Make the backend (goose serve) write into the same directory. gooseServe
// inherits process.env, so setting it here covers every spawned process.
process.env.GOOSE_LOG_DIR = LOG_DIR;

log.transports.file.resolvePathFn = () => {
  return path.join(LOG_DIR, 'main.log');
};

// Verbose logging is opt-in from Settings -> App -> Debug. Keep the default
// baseline quiet so normal use does not pay for log formatting and I/O.
const DEFAULT_FILE_LEVEL = 'error';
const DEFAULT_CONSOLE_LEVEL = false;

export function configureDebugLogging(enabled: boolean): void {
  log.transports.file.level = enabled ? 'debug' : DEFAULT_FILE_LEVEL;
  log.transports.console.level = enabled ? 'debug' : DEFAULT_CONSOLE_LEVEL;
}

configureDebugLogging(false);

export default log;
