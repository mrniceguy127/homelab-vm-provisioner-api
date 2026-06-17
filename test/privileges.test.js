import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

import { initializePrivilegeSupport } from '../src/privileges.js';

// Mock dependencies
vi.mock('node:fs/promises');
vi.mock('node:child_process');
vi.mock('../src/config-store.js', () => ({
  configRoot: '/test/configs',
  legacyConfigRoot: '/test/legacy-configs',
  legacyRuntimeRoot: '/test/legacy-runtime',
  legacyUserKeyRoot: '/test/legacy-keys',
  legacyVmDataRoot: '/test/legacy-vm-data',
  provisionerRoot: '/test/provisioner',
  userKeyRoot: '/test/keys',
  vmDataRoot: '/test/vm-data',
}));

describe('privileges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    process.getuid = vi.fn(() => 1000);
    process.getgid = vi.fn(() => 1000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initializePrivilegeSupport', () => {
    it('throws when running as root', async () => {
      process.getuid = vi.fn(() => 0);

      await expect(initializePrivilegeSupport()).rejects.toThrow('Do not run the API as root');
    });

    it('ensures sudo credentials are available', async () => {
      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };

      spawn.mockReturnValue(mockChild);

      fs.stat.mockResolvedValue({});
      fs.mkdir.mockResolvedValue();
      fs.readdir.mockResolvedValue([]);

      await initializePrivilegeSupport();

      expect(spawn).toHaveBeenCalledWith('sudo', ['-n', '-v'], expect.any(Object));
    });

    it('prompts for sudo if not cached', async () => {
      let callCount = 0;
      const mockChild1 = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(1);
        }),
      };

      const mockChild2 = {
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };

      spawn.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? mockChild1 : mockChild2;
      });

      fs.stat.mockResolvedValue({});
      fs.mkdir.mockResolvedValue();
      fs.readdir.mockResolvedValue([]);

      await initializePrivilegeSupport();

      expect(spawn).toHaveBeenCalledWith('sudo', ['-v'], expect.objectContaining({ stdio: 'inherit' }));
    });

    it('throws when not TTY and sudo not cached', async () => {
      process.stdin.isTTY = false;

      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(1);
        }),
      };

      spawn.mockReturnValue(mockChild);

      await expect(initializePrivilegeSupport()).rejects.toThrow('Sudo access is required');
    });

    it('repairs ownership of managed directories', async () => {
      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };

      spawn.mockReturnValue(mockChild);

      fs.stat.mockResolvedValue({});
      fs.mkdir.mockResolvedValue();
      fs.readdir.mockResolvedValue([]);

      await initializePrivilegeSupport();

      expect(spawn).toHaveBeenCalledWith(
        'sudo',
        expect.arrayContaining(['-n', 'chown', '-R', '1000:1000']),
        expect.any(Object),
      );
    });

    it('migrates legacy config files', async () => {
      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };

      spawn.mockReturnValue(mockChild);

      fs.stat.mockImplementation((filePath) => {
        if (filePath.includes('legacy')) return Promise.resolve({});
        if (filePath.includes('/test/configs/vm1.yaml') || filePath.includes('/test/keys/vm1_key') || filePath.includes('/test/vm-data/vm1'))
          return Promise.reject({ code: 'ENOENT' });
        return Promise.resolve({});
      });

      fs.mkdir.mockResolvedValue();
      fs.readdir.mockImplementation((dirPath) => {
        if (dirPath.includes('legacy-configs')) {
          return Promise.resolve([
            { name: 'vm1.yaml', isFile: () => true, isDirectory: () => false },
          ]);
        }
        if (dirPath.includes('legacy-keys')) {
          return Promise.resolve([
            { name: 'vm1_key', isFile: () => true, isDirectory: () => false },
          ]);
        }
        if (dirPath.includes('legacy-vm-data')) {
          return Promise.resolve([
            { name: 'vm1', isFile: () => false, isDirectory: () => true },
          ]);
        }
        return Promise.resolve([]);
      });

      fs.rename.mockResolvedValue();
      fs.readFile.mockResolvedValue('vm:\n  name: vm1');
      fs.writeFile.mockResolvedValue();

      await initializePrivilegeSupport();

      expect(fs.rename).toHaveBeenCalled();
      expect(fs.mkdir).toHaveBeenCalledWith('/test/configs', { recursive: true });
      expect(fs.mkdir).toHaveBeenCalledWith('/test/keys', { recursive: true });
      expect(fs.mkdir).toHaveBeenCalledWith('/test/vm-data', { recursive: true });
    });

    it('normalizes migrated config files', async () => {
      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };

      spawn.mockReturnValue(mockChild);

      const configWithLegacyFormat = `
vm:
  name: test-vm
  user: testuser
network:
  subnet_cidr: 192.168.1.0/24
`;

      fs.stat.mockResolvedValue({});
      fs.mkdir.mockResolvedValue();
      fs.readdir.mockImplementation((dirPath) => {
        if (dirPath.includes('legacy-configs')) {
          return Promise.resolve([
            { name: 'vm1.yaml', isFile: () => true, isDirectory: () => false },
          ]);
        }
        return Promise.resolve([]);
      });

      fs.rename.mockResolvedValue();
      fs.readFile.mockResolvedValue(configWithLegacyFormat);
      fs.writeFile.mockResolvedValue();

      await initializePrivilegeSupport();

      expect(fs.writeFile).toHaveBeenCalled();
      const writeCall = fs.writeFile.mock.calls.find(call => call[0].includes('vm1.yaml'));
      if (writeCall) {
        const normalizedContent = writeCall[1];
        expect(normalizedContent).toContain('cidr');
      }
    });

    it('skips ownership repair when no directories exist', async () => {
      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };

      spawn.mockReturnValue(mockChild);

      fs.stat.mockRejectedValue({ code: 'ENOENT' });
      fs.mkdir.mockResolvedValue();
      fs.readdir.mockResolvedValue([]);

      await initializePrivilegeSupport();

      const chownCalls = spawn.mock.calls.filter(call => call[1]?.includes('chown'));
      expect(chownCalls.length).toBe(0);
    });

    it('handles missing getuid/getgid gracefully', async () => {
      process.getuid = undefined;
      process.getgid = undefined;

      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };

      spawn.mockReturnValue(mockChild);

      fs.stat.mockResolvedValue({});
      fs.mkdir.mockResolvedValue();
      fs.readdir.mockResolvedValue([]);

      await initializePrivilegeSupport();

      const chownCalls = spawn.mock.calls.filter(call => call[1]?.includes('chown'));
      expect(chownCalls.length).toBe(0);
    });

    it('throws when chown fails', async () => {
      const mockSudoSuccess = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };

      const mockChownFail = {
        stdout: { on: vi.fn() },
        stderr: {
          on: vi.fn((event, callback) => {
            if (event === 'data') callback('Permission denied');
          }),
        },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(1);
        }),
      };

      spawn.mockImplementation((cmd, args) => {
        if (args.includes('chown')) return mockChownFail;
        return mockSudoSuccess;
      });

      fs.stat.mockResolvedValue({});
      fs.mkdir.mockResolvedValue();
      fs.readdir.mockResolvedValue([]);

      await expect(initializePrivilegeSupport()).rejects.toThrow('Permission denied');
    });

    it('moves files only when target is missing', async () => {
      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };

      spawn.mockReturnValue(mockChild);

      fs.stat.mockImplementation((filePath) => {
        if (filePath.includes('/test/configs/existing.yaml')) return Promise.resolve({});
        if (filePath.includes('legacy')) return Promise.resolve({});
        return Promise.reject({ code: 'ENOENT' });
      });

      fs.mkdir.mockResolvedValue();
      fs.readdir.mockImplementation((dirPath) => {
        if (dirPath.includes('legacy-configs')) {
          return Promise.resolve([
            { name: 'existing.yaml', isFile: () => true, isDirectory: () => false },
            { name: 'new.yaml', isFile: () => true, isDirectory: () => false },
          ]);
        }
        return Promise.resolve([]);
      });

      fs.rename.mockResolvedValue();
      fs.readFile.mockResolvedValue('vm:\n  name: vm1');
      fs.writeFile.mockResolvedValue();

      await initializePrivilegeSupport();

      expect(fs.rename).toHaveBeenCalledTimes(1);
      expect(fs.rename).toHaveBeenCalledWith(
        '/test/legacy-configs/new.yaml',
        '/test/configs/new.yaml',
      );
    });
  });
});
