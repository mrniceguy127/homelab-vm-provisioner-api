import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Need to set up mocks before any imports
const mockApp = {
  listen: vi.fn((port, callback) => callback && callback()),
};

const mockCreateApp = vi.fn(() => mockApp);
const mockInitializeDatabase = vi.fn().mockResolvedValue(undefined);
const mockInitializeNetworkModel = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/app.js', () => ({
  default: mockCreateApp,
}));

vi.mock('../src/db.js', () => ({
  initializeDatabase: mockInitializeDatabase,
}));

vi.mock('../src/network-model.js', () => ({
  initializeNetworkModel: mockInitializeNetworkModel,
}));

describe('server', () => {
  let originalEnv;
  let consoleWarnSpy;

  beforeEach(() => {
    originalEnv = process.env.PORT;
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.clearAllMocks();
    mockApp.listen.mockImplementation((port, callback) => callback && callback());
    mockCreateApp.mockReturnValue(mockApp);
    mockInitializeDatabase.mockResolvedValue(undefined);
    mockInitializeNetworkModel.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.PORT = originalEnv;
    vi.restoreAllMocks();
  });

  it('warns when network model initialization fails', async () => {
    vi.resetModules();
    mockInitializeNetworkModel.mockRejectedValueOnce({ code: 'ERR_UNKNOWN' });

    const { main } = await import('../src/server.js');
    await main();

    expect(consoleWarnSpy).toHaveBeenCalledWith('Network model initialization failed. Using defaults.');
    expect(mockApp.listen).toHaveBeenCalled();
  });

  it('warns when database initialization fails', async () => {
    vi.resetModules();
    mockInitializeDatabase.mockRejectedValueOnce(new Error('Database connection failed'));

    const { main } = await import('../src/server.js');
    await main();

    expect(consoleWarnSpy).toHaveBeenCalledWith('Database initialization failed. Job queue features will be unavailable.');
  });
});
