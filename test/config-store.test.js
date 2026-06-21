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
import {
  deleteStoredVmDefinition,
  listStoredVmDefinitions,
  loadStoredVmDefinitionByName,
  upsertStoredVmDefinition,
} from '../src/db.js';

vi.mock('node:fs/promises');
vi.mock('../src/db.js', () => ({
  upsertStoredVmDefinition: vi.fn(async () => ({ id: 42 })),
  deleteStoredVmDefinition: vi.fn(async () => null),
  loadStoredVmDefinitionByName: vi.fn(async () => null),
  listStoredVmDefinitions: vi.fn(async () => []),
}));

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
    it('returns true when VM definition exists', async () => {
      loadStoredVmDefinitionByName.mockResolvedValue({ id: 1, vm_name: 'test-vm', config: {} });

      const result = await storedConfigExists('test-vm');

      expect(result).toBe(true);
      expect(loadStoredVmDefinitionByName).toHaveBeenCalledWith('test-vm');
    });

    it('returns false when VM definition does not exist', async () => {
      loadStoredVmDefinitionByName.mockResolvedValue(null);

      const result = await storedConfigExists('nonexistent-vm');

      expect(result).toBe(false);
    });

    it('returns false when DB lookup throws', async () => {
      loadStoredVmDefinitionByName.mockRejectedValue(new Error('Permission denied'));

      await expect(storedConfigExists('test-vm')).resolves.toBe(false);
    });
  });

  describe('loadStoredConfig', () => {
    it('loads and serializes VM definition from DB', async () => {
      loadStoredVmDefinitionByName.mockResolvedValue({
        id: 7,
        vm_name: 'test-vm',
        config: {
          vm: {
            name: 'test-vm',
            user: 'testuser',
          },
          network: {
            mode: 'nat-auto',
          },
        },
      });

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
      expect(result.configPath).toBeNull();
      expect(result.vmDefinitionId).toBe(7);
      expect(result.rawConfig).toContain('name: test-vm');
    });

    it('throws not-found error when config missing', async () => {
      loadStoredVmDefinitionByName.mockResolvedValue(null);

      await expect(loadStoredConfig('missing-vm')).rejects.toMatchObject({
        message: expect.stringContaining('not found'),
        statusCode: 404,
      });
    });
  });

  describe('saveVmConfig', () => {
    beforeEach(() => {
      loadStoredVmDefinitionByName.mockResolvedValue(null);
      upsertStoredVmDefinition.mockResolvedValue({ id: 42 });
    });

    it('saves config as VM definition in DB', async () => {
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

      expect(upsertStoredVmDefinition).toHaveBeenCalledWith(expect.objectContaining({
        vm_name: 'test-vm',
        config: expect.objectContaining({ vm: expect.objectContaining({ name: 'test-vm' }) }),
      }));
      expect(result.vmName).toBe('test-vm');
      expect(result.configPath).toBeNull();
      expect(result.vmDefinitionId).toBe(42);
    });

    it('throws conflict error if config already exists', async () => {
      loadStoredVmDefinitionByName.mockResolvedValue({ id: 1, vm_name: 'existing-vm', config: {} });
      const config = { vm: { name: 'existing-vm' } };

      await expect(saveVmConfig({ config })).rejects.toMatchObject({
        message: expect.stringContaining('already in use'),
        statusCode: 409,
      });
    });

    it('allows overwrite when option is set', async () => {
      loadStoredVmDefinitionByName.mockResolvedValue({ id: 1, vm_name: 'existing-vm', config: {} });
      const config = { vm: { name: 'existing-vm' } };

      const result = await saveVmConfig({ config }, { overwrite: true });

      expect(result.vmName).toBe('existing-vm');
    });

    it('saves SSH public key when provided', async () => {
      const config = { vm: { name: 'test-vm' } };
      const sshPublicKey = 'ssh-rsa AAAAB3...';

      const result = await saveVmConfig({ config, sshPublicKey });

      expect(upsertStoredVmDefinition).toHaveBeenCalledWith(expect.objectContaining({
        ssh_public_key: 'ssh-rsa AAAAB3...\n',
      }));
      expect(result.keyPath).toBeNull();
      expect(result.config.vm.ssh_key_file).toBeUndefined();
    });

    it('saves setup script when provided', async () => {
      const config = { vm: { name: 'test-vm' } };
      const setupScript = '#!/bin/bash\necho "setup"';

      const result = await saveVmConfig({ config, setupScript });

      expect(upsertStoredVmDefinition).toHaveBeenCalledWith(expect.objectContaining({
        setup_script: '#!/bin/bash\necho "setup"\n',
      }));
      expect(result.scriptPath).toBeNull();
      expect(result.config.scripts?.setup_script_file).toBeUndefined();
    });

    it('rejects file-backed SSH key references for API-managed VMs', async () => {
      const config = {
        vm: {
          name: 'test-vm',
          ssh_key_file: 'vm/keys/users/relative/path.pub',
        },
      };

      await expect(saveVmConfig({ config })).rejects.toMatchObject({
        message: expect.stringContaining('ssh_key_file is not supported'),
        statusCode: 422,
      });
    });

    it('rejects file-backed setup script references for API-managed VMs', async () => {
      const config = {
        vm: { name: 'test-vm' },
        scripts: {
          setup_script_file: 'vm/scripts/relative/script.sh',
        },
      };

      await expect(saveVmConfig({ config })).rejects.toMatchObject({
        message: expect.stringContaining('setup_script_file is not supported'),
        statusCode: 422,
      });
    });

    it('removes empty paths section', async () => {
      const config = {
        vm: { name: 'test-vm' },
        paths: {},
      };

      const result = await saveVmConfig({ config });

      expect(result.rawConfig).not.toContain('paths:');
    });

    it('removes empty scripts section', async () => {
      const config = {
        vm: { name: 'test-vm' },
        scripts: {},
      };

      const result = await saveVmConfig({ config });

      expect(result.rawConfig).not.toContain('scripts:');
    });
  });

  describe('deleteSavedConfigArtifacts', () => {
    it('deletes stored VM definition', async () => {
      const savedConfig = {
        vmName: 'test-vm',
      };

      await deleteSavedConfigArtifacts(savedConfig);

      expect(deleteStoredVmDefinition).toHaveBeenCalledWith('test-vm');
    });

    it('ignores 404 delete errors', async () => {
      deleteStoredVmDefinition.mockRejectedValue({ statusCode: 404 });

      const savedConfig = { vmName: 'test-vm' };

      await expect(deleteSavedConfigArtifacts(savedConfig)).resolves.not.toThrow();
    });

    it('throws non-ENOENT errors', async () => {
      deleteStoredVmDefinition.mockRejectedValue(new Error('Permission denied'));

      const savedConfig = { vmName: 'test-vm' };

      await expect(deleteSavedConfigArtifacts(savedConfig)).rejects.toThrow('Permission denied');
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
    it('is a no-op for service-managed API mode', async () => {
      await ensureRuntimeDirectories();

      expect(fs.mkdir).not.toHaveBeenCalled();
    });
  });

  describe('listStoredConfigNames', () => {
    it('lists all VM definitions from DB', async () => {
      listStoredVmDefinitions.mockResolvedValue([
        { vm_name: 'vm1' },
        { vm_name: 'vm2' },
      ]);

      const result = await listStoredConfigNames();

      expect(result).toEqual(['vm1', 'vm2']);
    });

    it('returns empty array when DB lookup fails', async () => {
      listStoredVmDefinitions.mockRejectedValue(new Error('db unavailable'));

      const result = await listStoredConfigNames();

      expect(result).toEqual([]);
    });

    it('sorts results alphabetically', async () => {
      listStoredVmDefinitions.mockResolvedValue([
        { vm_name: 'zebra' },
        { vm_name: 'alpha' },
        { vm_name: 'beta' },
      ]);

      const result = await listStoredConfigNames();

      expect(result).toEqual(['alpha', 'beta', 'zebra']);
    });
  });
});
