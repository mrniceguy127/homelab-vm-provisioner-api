import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs/promises';

import {
  apiRoot,
  provisionerRoot,
  configRoot,
  configPathForVm,
  storedConfigExists,
  loadStoredConfig,
  saveVmConfig,
  deleteSavedConfigArtifacts,
  getVmLogPath,
  ensureRuntimeDirectories,
  listStoredConfigNames,
} from '../src/config-store.js';

vi.mock('node:fs/promises');

describe('config-store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('module exports', () => {
    it('exports apiRoot', () => {
      expect(apiRoot).toBeDefined();
      expect(typeof apiRoot).toBe('string');
    });

    it('exports provisionerRoot', () => {
      expect(provisionerRoot).toBeDefined();
      expect(typeof provisionerRoot).toBe('string');
    });

    it('exports configRoot', () => {
      expect(configRoot).toBeDefined();
      expect(typeof configRoot).toBe('string');
    });
  });

  describe('configPathForVm', () => {
    it('returns config file path for VM name', () => {
      const result = configPathForVm('test-vm');
      expect(result).toContain('test-vm.yaml');
      expect(result).toContain('configs');
    });

    it('handles VM names with hyphens', () => {
      const result = configPathForVm('my-test-vm');
      expect(result).toContain('my-test-vm.yaml');
    });
  });

  describe('storedConfigExists', () => {
    it('returns true when config file exists', async () => {
      fs.access.mockResolvedValue();

      const result = await storedConfigExists('test-vm');

      expect(result).toBe(true);
      expect(fs.access).toHaveBeenCalled();
    });

    it('returns false when config file does not exist', async () => {
      fs.access.mockRejectedValue({ code: 'ENOENT' });

      const result = await storedConfigExists('nonexistent-vm');

      expect(result).toBe(false);
    });

    it('throws on non-ENOENT errors', async () => {
      fs.access.mockRejectedValue(new Error('Permission denied'));

      await expect(storedConfigExists('test-vm')).rejects.toThrow('Permission denied');
    });
  });

  describe('loadStoredConfig', () => {
    it('loads and parses YAML config file', async () => {
      const configYaml = `vm:
  name: test-vm
  user: testuser
network:
  mode: nat-auto
`;
      fs.readFile.mockResolvedValue(configYaml);

      const result = await loadStoredConfig('test-vm');

      expect(result.vmName).toBe('test-vm');
      expect(result.config).toEqual({
        vm: {
          name: 'test-vm',
          user: 'testuser',
        },
        network: {
          mode: 'nat-auto',
        },
      });
      expect(result.configPath).toContain('test-vm.yaml');
      expect(result.rawConfig).toBe(configYaml);
    });

    it('throws not-found error when config missing', async () => {
      fs.readFile.mockRejectedValue({ code: 'ENOENT' });

      await expect(loadStoredConfig('missing-vm')).rejects.toMatchObject({
        message: expect.stringContaining('not found'),
        statusCode: 404,
      });
    });

    it('throws on read errors', async () => {
      fs.readFile.mockRejectedValue(new Error('Read failed'));

      await expect(loadStoredConfig('test-vm')).rejects.toThrow('Read failed');
    });
  });

  describe('saveVmConfig', () => {
    beforeEach(() => {
      fs.mkdir.mockResolvedValue();
      fs.writeFile.mockResolvedValue();
      fs.access.mockRejectedValue({ code: 'ENOENT' });
    });

    it('saves config as YAML file', async () => {
      const config = {
        vm: {
          name: 'test-vm',
          user: 'testuser',
        },
        network: {
          mode: 'nat-auto',
        },
      };

      const result = await saveVmConfig({ config });

      expect(fs.mkdir).toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('test-vm.yaml'),
        expect.stringContaining('name: test-vm'),
        'utf8',
      );
      expect(result.vmName).toBe('test-vm');
      expect(result.configPath).toContain('test-vm.yaml');
    });

    it('creates runtime directories', async () => {
      const config = { vm: { name: 'test-vm' } };

      await saveVmConfig({ config });

      expect(fs.mkdir).toHaveBeenCalled();
    });

    it('throws conflict error if config already exists', async () => {
      fs.access.mockResolvedValue();
      const config = { vm: { name: 'existing-vm' } };

      await expect(saveVmConfig({ config })).rejects.toMatchObject({
        message: expect.stringContaining('already in use'),
        statusCode: 409,
      });
    });

    it('allows overwrite when option is set', async () => {
      fs.access.mockResolvedValue();
      const config = { vm: { name: 'existing-vm' } };

      const result = await saveVmConfig({ config }, { overwrite: true });

      expect(result.vmName).toBe('existing-vm');
    });

    it('saves SSH public key when provided', async () => {
      const config = { vm: { name: 'test-vm' } };
      const sshPublicKey = 'ssh-rsa AAAAB3...';

      const result = await saveVmConfig({ config, sshPublicKey });

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('test-vm.pub'),
        expect.stringContaining('ssh-rsa'),
        'utf8',
      );
      expect(result.keyPath).toContain('test-vm.pub');
    });

    it('saves setup script when provided', async () => {
      const config = { vm: { name: 'test-vm' } };
      const setupScript = '#!/bin/bash\necho "setup"';

      const result = await saveVmConfig({ config, setupScript });

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('test-vm-setup.sh'),
        expect.stringContaining('#!/bin/bash'),
        'utf8',
      );
      expect(result.scriptPath).toContain('test-vm-setup.sh');
    });

    it('validates absolute path for existing SSH key file', async () => {
      const config = {
        vm: {
          name: 'test-vm',
          ssh_key_file: 'relative/path.pub',
        },
      };

      await expect(saveVmConfig({ config })).rejects.toMatchObject({
        message: expect.stringContaining('absolute path'),
        statusCode: 422,
      });
    });

    it('validates absolute path for existing setup script', async () => {
      const config = {
        vm: { name: 'test-vm' },
        scripts: {
          setup_script_file: 'relative/script.sh',
        },
      };

      await expect(saveVmConfig({ config })).rejects.toMatchObject({
        message: expect.stringContaining('absolute path'),
        statusCode: 422,
      });
    });

    it('removes empty paths section', async () => {
      const config = {
        vm: { name: 'test-vm' },
        paths: {},
      };

      await saveVmConfig({ config });

      const writeCall = fs.writeFile.mock.calls.find(call => call[0].includes('test-vm.yaml'));
      expect(writeCall[1]).not.toContain('paths:');
    });

    it('removes empty scripts section', async () => {
      const config = {
        vm: { name: 'test-vm' },
        scripts: {},
      };

      await saveVmConfig({ config });

      const writeCall = fs.writeFile.mock.calls.find(call => call[0].includes('test-vm.yaml'));
      expect(writeCall[1]).not.toContain('scripts:');
    });
  });

  describe('deleteSavedConfigArtifacts', () => {
    it('deletes all saved artifacts', async () => {
      fs.unlink.mockResolvedValue();

      const savedConfig = {
        configPath: '/configs/test-vm.yaml',
        keyPath: '/keys/test-vm.pub',
        scriptPath: '/scripts/test-vm-setup.sh',
      };

      await deleteSavedConfigArtifacts(savedConfig);

      expect(fs.unlink).toHaveBeenCalledTimes(3);
      expect(fs.unlink).toHaveBeenCalledWith('/configs/test-vm.yaml');
      expect(fs.unlink).toHaveBeenCalledWith('/keys/test-vm.pub');
      expect(fs.unlink).toHaveBeenCalledWith('/scripts/test-vm-setup.sh');
    });

    it('ignores ENOENT errors', async () => {
      fs.unlink.mockRejectedValue({ code: 'ENOENT' });

      const savedConfig = { configPath: '/configs/test-vm.yaml' };

      await expect(deleteSavedConfigArtifacts(savedConfig)).resolves.not.toThrow();
    });

    it('throws non-ENOENT errors', async () => {
      fs.unlink.mockRejectedValue(new Error('Permission denied'));

      const savedConfig = { configPath: '/configs/test-vm.yaml' };

      await expect(deleteSavedConfigArtifacts(savedConfig)).rejects.toThrow('Permission denied');
    });

    it('handles null artifact paths', async () => {
      fs.unlink.mockResolvedValue();

      const savedConfig = {
        configPath: '/configs/test-vm.yaml',
        keyPath: null,
        scriptPath: null,
      };

      await deleteSavedConfigArtifacts(savedConfig);

      expect(fs.unlink).toHaveBeenCalledTimes(1);
    });
  });

  describe('getVmLogPath', () => {
    it('returns log file path for VM', () => {
      const result = getVmLogPath('test-vm');

      expect(result).toBe('/var/log/libvirt/qemu/test-vm.log');
    });

    it('uses VM name directly in path', () => {
      const result = getVmLogPath('my-special-vm');

      expect(result).toContain('my-special-vm.log');
    });
  });

  describe('ensureRuntimeDirectories', () => {
    it('creates all runtime directories', async () => {
      fs.mkdir.mockResolvedValue();

      await ensureRuntimeDirectories();

      expect(fs.mkdir).toHaveBeenCalledTimes(4);
      expect(fs.mkdir).toHaveBeenCalledWith(
        expect.stringContaining('configs'),
        { recursive: true },
      );
    });
  });

  describe('listStoredConfigNames', () => {
    it('lists all YAML config files', async () => {
      fs.readdir.mockResolvedValue([
        { name: 'vm1.yaml', isFile: () => true },
        { name: 'vm2.yaml', isFile: () => true },
        { name: 'other.txt', isFile: () => true },
        { name: 'subdir', isFile: () => false },
      ]);

      const result = await listStoredConfigNames();

      expect(result).toEqual(['vm1', 'vm2']);
    });

    it('returns empty array when directory does not exist', async () => {
      fs.readdir.mockRejectedValue({ code: 'ENOENT' });

      const result = await listStoredConfigNames();

      expect(result).toEqual([]);
    });

    it('sorts results alphabetically', async () => {
      fs.readdir.mockResolvedValue([
        { name: 'zebra.yaml', isFile: () => true },
        { name: 'alpha.yaml', isFile: () => true },
        { name: 'beta.yaml', isFile: () => true },
      ]);

      const result = await listStoredConfigNames();

      expect(result).toEqual(['alpha', 'beta', 'zebra']);
    });

    it('throws on non-ENOENT errors', async () => {
      fs.readdir.mockRejectedValue(new Error('Permission denied'));

      await expect(listStoredConfigNames()).rejects.toThrow('Permission denied');
    });
  });
});
