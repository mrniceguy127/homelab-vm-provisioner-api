import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  createValidationError,
  createConflictError,
  createNotFoundError,
  saveVmDefinition,
  loadVmDefinition,
  listVmDefinitions,
  deleteVmDefinition,
  vmDefinitionExists,
  saveVmConfig,
  loadStoredConfig,
  listStoredConfigNames,
  deleteSavedConfigArtifacts,
  storedConfigExists,
  configPathForVm,
} from '../src/vm-definitions.js';

import * as db from '../src/db.js';

// Mock database module
vi.mock('../src/db.js', () => ({
  upsertStoredVmDefinition: vi.fn(),
  loadStoredVmDefinitionByName: vi.fn(),
  listStoredVmDefinitions: vi.fn(),
  deleteStoredVmDefinition: vi.fn(),
}));

describe('vm-definitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('error creators', () => {
    it('createValidationError creates 422 error', () => {
      const error = createValidationError('Invalid input', [{ field: 'name' }]);
      expect(error.message).toBe('Invalid input');
      expect(error.statusCode).toBe(422);
      expect(error.details).toEqual([{ field: 'name' }]);
    });

    it('createConflictError creates 409 error', () => {
      const error = createConflictError('Resource exists');
      expect(error.message).toBe('Resource exists');
      expect(error.statusCode).toBe(409);
    });

    it('createNotFoundError creates 404 error', () => {
      const error = createNotFoundError('Not found');
      expect(error.message).toBe('Not found');
      expect(error.statusCode).toBe(404);
    });
  });

  describe('saveVmDefinition', () => {
    it('saves a valid VM definition', async () => {
      const definition = { vm: { name: 'test-vm' } };
      db.upsertStoredVmDefinition.mockResolvedValue({ id: 1 });

      await saveVmDefinition('test-vm', definition);

      expect(db.upsertStoredVmDefinition).toHaveBeenCalledWith('test-vm', definition);
    });

    it('throws validation error when name is empty', async () => {
      await expect(saveVmDefinition('', { vm: {} })).rejects.toThrow('VM name is required');
    });

    it('throws validation error when definition is not an object', async () => {
      await expect(saveVmDefinition('test-vm', null)).rejects.toThrow('VM definition must be an object');
      await expect(saveVmDefinition('test-vm', 'not an object')).rejects.toThrow('VM definition must be an object');
    });
  });

  describe('loadVmDefinition', () => {
    it('loads an existing VM definition', async () => {
      const definition = { vm: { name: 'test-vm' } };
      db.loadStoredVmDefinitionByName.mockResolvedValue(definition);

      const result = await loadVmDefinition('test-vm');

      expect(result).toEqual(definition);
      expect(db.loadStoredVmDefinitionByName).toHaveBeenCalledWith('test-vm');
    });

    it('throws validation error when name is empty', async () => {
      await expect(loadVmDefinition('')).rejects.toThrow('VM name is required');
    });

    it('throws not found error when definition does not exist', async () => {
      db.loadStoredVmDefinitionByName.mockResolvedValue(null);

      await expect(loadVmDefinition('nonexistent')).rejects.toThrow('VM definition not found: nonexistent');
    });
  });

  describe('listVmDefinitions', () => {
    it('returns list of VM definitions', async () => {
      const definitions = [
        { vm_name: 'vm1', config: {} },
        { vm_name: 'vm2', config: {} },
      ];
      db.listStoredVmDefinitions.mockResolvedValue(definitions);

      const result = await listVmDefinitions();

      expect(result).toEqual(definitions);
      expect(db.listStoredVmDefinitions).toHaveBeenCalled();
    });
  });

  describe('deleteVmDefinition', () => {
    it('deletes a VM definition', async () => {
      db.deleteStoredVmDefinition.mockResolvedValue();

      await deleteVmDefinition('test-vm');

      expect(db.deleteStoredVmDefinition).toHaveBeenCalledWith('test-vm');
    });

    it('throws validation error when name is empty', async () => {
      await expect(deleteVmDefinition('')).rejects.toThrow('VM name is required');
    });
  });

  describe('vmDefinitionExists', () => {
    it('returns true when definition exists', async () => {
      db.loadStoredVmDefinitionByName.mockResolvedValue({ vm: {} });

      const result = await vmDefinitionExists('test-vm');

      expect(result).toBe(true);
    });

    it('returns false when definition does not exist', async () => {
      db.loadStoredVmDefinitionByName.mockResolvedValue(null);

      const result = await vmDefinitionExists('nonexistent');

      expect(result).toBe(false);
    });

    it('rethrows non-404 errors', async () => {
      const error = new Error('Database error');
      error.statusCode = 500;
      db.loadStoredVmDefinitionByName.mockRejectedValue(error);

      await expect(vmDefinitionExists('test-vm')).rejects.toThrow('Database error');
    });
  });

  describe('saveVmConfig', () => {
    beforeEach(() => {
      process.env.HOST_ID = 'test-host';
    });

    it('saves a VM config successfully', async () => {
      const config = {
        vm: { name: 'test-vm', owner_user_id: 'user1', network_group_id: 'net1' },
      };
      db.upsertStoredVmDefinition.mockResolvedValue({ id: 123 });
      db.loadStoredVmDefinitionByName.mockResolvedValue(null);

      const result = await saveVmConfig({ config });

      expect(result.vmName).toBe('test-vm');
      expect(result.vmDefinitionId).toBe(123);
      expect(result.config).toBeDefined();
      expect(db.upsertStoredVmDefinition).toHaveBeenCalled();
    });

    it('throws conflict error when VM already exists and overwrite is false', async () => {
      const config = { vm: { name: 'existing-vm' } };
      db.loadStoredVmDefinitionByName.mockResolvedValue({ vm: {} });

      await expect(saveVmConfig({ config })).rejects.toThrow('VM name is already in use');
    });

    it('allows overwrite when overwrite option is true', async () => {
      const config = { vm: { name: 'existing-vm' } };
      db.loadStoredVmDefinitionByName.mockResolvedValue({ vm: {} });
      db.upsertStoredVmDefinition.mockResolvedValue({ id: 456 });

      const result = await saveVmConfig({ config }, { overwrite: true });

      expect(result.vmDefinitionId).toBe(456);
    });

    it('rejects ssh_key_file in config', async () => {
      const config = {
        vm: { name: 'test-vm', ssh_key_file: '/path/to/key' },
      };
      db.loadStoredVmDefinitionByName.mockResolvedValue(null);

      await expect(saveVmConfig({ config })).rejects.toThrow('ssh_key_file is not supported');
    });

    it('rejects setup_script_file in config', async () => {
      const config = {
        vm: { name: 'test-vm' },
        scripts: { setup_script_file: '/path/to/script' },
      };
      db.loadStoredVmDefinitionByName.mockResolvedValue(null);

      await expect(saveVmConfig({ config })).rejects.toThrow('setup_script_file is not supported');
    });

    it('includes SSH public key in saved definition', async () => {
      const config = { vm: { name: 'test-vm' } };
      const sshPublicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey';
      db.upsertStoredVmDefinition.mockResolvedValue({ id: 789 });
      db.loadStoredVmDefinitionByName.mockResolvedValue(null);

      await saveVmConfig({ config, sshPublicKey });

      const call = db.upsertStoredVmDefinition.mock.calls[0][0];
      expect(call.ssh_public_key).toContain('ssh-ed25519');
    });

    it('includes setup script in saved definition', async () => {
      const config = { vm: { name: 'test-vm' } };
      const setupScript = '#!/bin/bash\necho hello';
      db.upsertStoredVmDefinition.mockResolvedValue({ id: 101 });
      db.loadStoredVmDefinitionByName.mockResolvedValue(null);

      await saveVmConfig({ config, setupScript });

      const call = db.upsertStoredVmDefinition.mock.calls[0][0];
      expect(call.setup_script).toContain('echo hello');
    });

    it('skips persistence when persist option is false', async () => {
      const config = { vm: { name: 'test-vm' } };
      db.loadStoredVmDefinitionByName.mockResolvedValue(null);

      const result = await saveVmConfig({ config }, { persist: false });

      expect(result.vmDefinitionId).toBe(null);
      expect(db.upsertStoredVmDefinition).not.toHaveBeenCalled();
    });

    it('removes empty scripts object from config', async () => {
      const config = {
        vm: { name: 'test-vm' },
        scripts: {},
      };
      db.upsertStoredVmDefinition.mockResolvedValue({ id: 111 });
      db.loadStoredVmDefinitionByName.mockResolvedValue(null);

      await saveVmConfig({ config });

      const call = db.upsertStoredVmDefinition.mock.calls[0][0];
      expect(call.config.scripts).toBeUndefined();
    });

    it('removes empty paths object from config', async () => {
      const config = {
        vm: { name: 'test-vm' },
        paths: {},
      };
      db.upsertStoredVmDefinition.mockResolvedValue({ id: 222 });
      db.loadStoredVmDefinitionByName.mockResolvedValue(null);

      await saveVmConfig({ config });

      const call = db.upsertStoredVmDefinition.mock.calls[0][0];
      expect(call.config.paths).toBeUndefined();
    });
  });

  describe('loadStoredConfig', () => {
    it('loads a stored config successfully', async () => {
      const vmDef = {
        id: 456,
        vm_name: 'test-vm',
        config: { vm: { name: 'test-vm' } },
      };
      db.loadStoredVmDefinitionByName.mockResolvedValue(vmDef);

      const result = await loadStoredConfig('test-vm');

      expect(result.vmName).toBe('test-vm');
      expect(result.vmDefinitionId).toBe(456);
      expect(result.config).toBeDefined();
      expect(result.configPath).toBe(null);
    });

    it('throws not found error when definition does not exist', async () => {
      db.loadStoredVmDefinitionByName.mockRejectedValue(new Error('Not found'));

      await expect(loadStoredConfig('nonexistent')).rejects.toThrow('Stored definition was not found');
    });

    it('handles missing config gracefully', async () => {
      const vmDef = {
        id: 789,
        vm_name: 'test-vm',
        config: null,
      };
      db.loadStoredVmDefinitionByName.mockResolvedValue(vmDef);

      const result = await loadStoredConfig('test-vm');

      expect(result.config).toEqual({});
    });
  });

  describe('listStoredConfigNames', () => {
    it('returns sorted list of VM names', async () => {
      const definitions = [
        { vm_name: 'zulu-vm' },
        { vm_name: 'alpha-vm' },
        { vm_name: 'bravo-vm' },
      ];
      db.listStoredVmDefinitions.mockResolvedValue(definitions);

      const result = await listStoredConfigNames();

      expect(result).toEqual(['alpha-vm', 'bravo-vm', 'zulu-vm']);
    });

    it('returns empty array on database error', async () => {
      db.listStoredVmDefinitions.mockRejectedValue(new Error('DB error'));

      const result = await listStoredConfigNames();

      expect(result).toEqual([]);
    });
  });

  describe('deleteSavedConfigArtifacts', () => {
    it('deletes VM definition by name', async () => {
      db.deleteStoredVmDefinition.mockResolvedValue();

      await deleteSavedConfigArtifacts({ vmName: 'test-vm' });

      expect(db.deleteStoredVmDefinition).toHaveBeenCalledWith('test-vm');
    });

    it('ignores 404 errors when deleting', async () => {
      const error = new Error('Not found');
      error.statusCode = 404;
      db.deleteStoredVmDefinition.mockRejectedValue(error);

      await expect(deleteSavedConfigArtifacts({ vmName: 'test-vm' })).resolves.not.toThrow();
    });

    it('rethrows non-404 errors', async () => {
      const error = new Error('DB error');
      error.statusCode = 500;
      db.deleteStoredVmDefinition.mockRejectedValue(error);

      await expect(deleteSavedConfigArtifacts({ vmName: 'test-vm' })).rejects.toThrow('DB error');
    });

    it('does nothing when savedConfig is null', async () => {
      await deleteSavedConfigArtifacts(null);

      expect(db.deleteStoredVmDefinition).not.toHaveBeenCalled();
    });

    it('does nothing when vmName is missing', async () => {
      await deleteSavedConfigArtifacts({ vmDefinitionId: 123 });

      expect(db.deleteStoredVmDefinition).not.toHaveBeenCalled();
    });
  });

  describe('storedConfigExists', () => {
    it('returns true when config exists', async () => {
      db.loadStoredVmDefinitionByName.mockResolvedValue({ vm: {} });

      const result = await storedConfigExists('test-vm');

      expect(result).toBe(true);
    });

    it('returns false when config does not exist', async () => {
      db.loadStoredVmDefinitionByName.mockResolvedValue(null);

      const result = await storedConfigExists('nonexistent');

      expect(result).toBe(false);
    });
  });

  describe('configPathForVm', () => {
    it('always returns null for DB-backed VMs', () => {
      expect(configPathForVm('any-vm')).toBe(null);
      expect(configPathForVm('another-vm')).toBe(null);
      expect(configPathForVm('')).toBe(null);
    });
  });
});
