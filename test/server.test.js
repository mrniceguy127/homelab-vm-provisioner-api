import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Need to set up mocks before any imports
const mockApp = {
  listen: vi.fn((port, callback) => callback && callback()),
};

const mockInitializeNetworkModel = vi.fn().mockResolvedValue(undefined);
const mockInitializePrivilegeSupport = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/app.js', () => ({
  default: mockApp,
}));

vi.mock('../src/network-model.js', () => ({
  initializeNetworkModel: mockInitializeNetworkModel,
}));

vi.mock('../src/privileges.js', () => ({
  initializePrivilegeSupport: mockInitializePrivilegeSupport,
}));

describe('server', () => {
  let originalEnv;
  let consoleLogSpy;
  let consoleErrorSpy;
  let processExitSpy;

  beforeEach(() => {
    originalEnv = process.env.PORT;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    vi.clearAllMocks();
    mockApp.listen.mockImplementation((port, callback) => callback && callback());
    mockInitializeNetworkModel.mockResolvedValue(undefined);
    mockInitializePrivilegeSupport.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.PORT = originalEnv;
    vi.restoreAllMocks();
  });

  it('starts server on default port 3000', async () => {
    delete process.env.PORT;
    vi.resetModules();

    await import('../src/server.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockApp.listen).toHaveBeenCalledWith(3000, expect.any(Function));
  });

  it('starts server on custom port from environment', async () => {
    process.env.PORT = '4000';
    vi.resetModules();

    await import('../src/server.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockApp.listen).toHaveBeenCalledWith(4000, expect.any(Function));
  });

  it('initializes privilege support before listening', async () => {
    vi.resetModules();

    await import('../src/server.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockInitializePrivilegeSupport).toHaveBeenCalled();
  });

  it('initializes network model before listening', async () => {
    vi.resetModules();

    await import('../src/server.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockInitializeNetworkModel).toHaveBeenCalled();
  });

  it('logs startup message when listening', async () => {
    vi.resetModules();

    await import('../src/server.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('homelab-vm-provisioner-api listening on port'),
    );
  });

  it('exits with code 1 on initialization error', async () => {
    vi.resetModules();
    mockInitializePrivilegeSupport.mockRejectedValueOnce(new Error('Initialization failed'));

    await import('../src/server.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Initialization failed'));
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('handles error objects without message', async () => {
    vi.resetModules();
    mockInitializePrivilegeSupport.mockRejectedValueOnce({ code: 'ERR_UNKNOWN' });

    await import('../src/server.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});
