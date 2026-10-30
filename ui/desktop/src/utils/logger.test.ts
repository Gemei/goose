import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLog = vi.hoisted(() => ({
  transports: {
    file: { level: 'info' as string | false, resolvePathFn: () => {} },
    console: { level: 'info' as string | false },
  },
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/goose',
  },
}));

vi.mock('electron-log', () => ({
  default: mockLog,
}));

describe('logger', () => {
  beforeEach(async () => {
    vi.resetModules();
    delete process.env.GOOSE_LOG_DIR;
    mockLog.transports.file.level = 'info';
    mockLog.transports.console.level = 'info';
    await import('./logger');
  });

  it('points electron-log and the backend at the same log directory', async () => {
    const { LOG_DIR } = await import('./logger');

    const expectedDir = path.join('/tmp/goose', 'logs');
    expect(LOG_DIR).toBe(expectedDir);
    expect(process.env.GOOSE_LOG_DIR).toBe(expectedDir);
    expect(mockLog.transports.file.resolvePathFn()).toBe(path.join(expectedDir, 'main.log'));
  });

  it('keeps verbose logging off by default', () => {
    expect(mockLog.transports.file.level).toBe('error');
    expect(mockLog.transports.console.level).toBe(false);
  });

  it('enables debug logging only when requested', async () => {
    const { configureDebugLogging } = await import('./logger');

    configureDebugLogging(true);
    expect(mockLog.transports.file.level).toBe('debug');
    expect(mockLog.transports.console.level).toBe('debug');

    configureDebugLogging(false);
    expect(mockLog.transports.file.level).toBe('error');
    expect(mockLog.transports.console.level).toBe(false);
  });
});
