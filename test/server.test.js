import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Need to set up mocks before any imports
const mockApp = {
  listen: vi.fn((port, callback) => callback && callback()),
};

const mockInitializeDatabase = vi.fn().mockResolvedValue(undefined);
const mockInitializeNetworkModel = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/app.js', () => ({
  default: mockApp,
}));

vi.mock('../src/db.js', () => ({
  initializeDatabase: mockInitializeDatabase,
}));

vi.mock('../src/network-model.js', () => ({
  initializeNetworkModel: mockInitializeNetworkModel,
}));

describe('server', () => {
  let originalEnv;
  let consoleErrorSpy;
  let consoleWarnSpy;
  let processExitSpy;

  beforeEach(() => {
    originalEnv = process.env.PORT;
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    vi.clearAllMocks();
    mockApp.listen.mockImplementation((port, callback) => callback && callback());
    mockInitializeDatabase.mockResolvedValue(undefined);
    mockInitializeNetworkModel.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.PORT = originalEnv;
    vi.restoreAllMocks();
  });

  it('handles error objects without message', async () => {
    vi.resetModules();
    mockInitializeNetworkModel.mockRejectedValueOnce({ code: 'ERR_UNKNOWN' });

    await import('../src/server.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('warns when database initialization fails', async () => {
    vi.resetModules();
    mockInitializeDatabase.mockRejectedValueOnce(new Error('Database connection failed'));

    await import('../src/server.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(consoleWarnSpy).toHaveBeenCalledWith('Database initialization failed. Job queue features will be unavailable.');
  });
});
