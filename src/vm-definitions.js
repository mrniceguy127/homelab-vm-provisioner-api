/**
 * VM definition repository - DB-backed VM definitions for API-managed VMs.
 * 
 * API-managed VMs use PostgreSQL as the source of truth for VM definitions.
 * This module provides the interface for saving, loading, listing, and deleting
 * VM definitions from the database.
 */

import yaml from 'js-yaml';

import {
  deleteStoredVmDefinition,
  listStoredVmDefinitions,
  loadStoredVmDefinitionByName,
  upsertStoredVmDefinition,
} from './db.js';

/**
 * Create an HTTP 422 validation error.
 *
 * @param {string} message - Validation error message.
 * @param {Array<object>} [details=[]] - Optional validation detail list.
 * @returns {Error} Error tagged with `statusCode` 422.
 */
export function createValidationError(message, details = []) {
  const error = new Error(message);
  error.statusCode = 422;
  error.details = details;
  return error;
}

/**
 * Create an HTTP 409 conflict error.
 *
 * @param {string} message - Conflict description.
 * @returns {Error} Error tagged with `statusCode` 409.
 */
export function createConflictError(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

/**
 * Create an HTTP 404 not-found error.
 *
 * @param {string} message - Not-found description.
 * @returns {Error} Error tagged with `statusCode` 404.
 */
export function createNotFoundError(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

/**
 * Save a VM definition to the database.
 *
 * @param {string} vmName - VM name.
 * @param {object} definition - VM definition object.
 * @returns {Promise<void>}
 */
export async function saveVmDefinition(vmName, definition) {
  if (!vmName) {
    throw createValidationError('VM name is required');
  }
  if (!definition || typeof definition !== 'object') {
    throw createValidationError('VM definition must be an object');
  }

  await upsertStoredVmDefinition(vmName, definition);
}

/**
 * Load a VM definition from the database.
 *
 * @param {string} vmName - VM name.
 * @returns {Promise<object>} VM definition object.
 * @throws {Error} If the VM definition is not found.
 */
export async function loadVmDefinition(vmName) {
  if (!vmName) {
    throw createValidationError('VM name is required');
  }

  const definition = await loadStoredVmDefinitionByName(vmName);
  if (!definition) {
    throw createNotFoundError(`VM definition not found: ${vmName}`);
  }

  return definition;
}

/**
 * List all VM definitions from the database.
 *
 * @returns {Promise<Array<object>>} Array of VM definition objects.
 */
export async function listVmDefinitions() {
  return await listStoredVmDefinitions();
}

/**
 * Delete a VM definition from the database.
 *
 * @param {string} vmName - VM name.
 * @returns {Promise<void>}
 */
export async function deleteVmDefinition(vmName) {
  if (!vmName) {
    throw createValidationError('VM name is required');
  }

  await deleteStoredVmDefinition(vmName);
}

/**
 * Check if a VM definition exists in the database.
 *
 * @param {string} vmName - VM name.
 * @returns {Promise<boolean>} True if the VM definition exists.
 */
export async function vmDefinitionExists(vmName) {
  try {
    await loadVmDefinition(vmName);
    return true;
  } catch (error) {
    if (error.statusCode === 404) {
      return false;
    }
    throw error;
  }
}

/**
 * Clone a VM definition object for manipulation.
 * 
 * @param {object} definition - VM definition object.
 * @returns {object} Cloned definition.
 */
function cloneDefinition(definition) {
  return JSON.parse(JSON.stringify(definition));
}

/**
 * Save a VM config using DB-backed VM definitions.
 *
 * @param {{config: object, sshPublicKey?: string, setupScript?: string}} payload - Save request payload.
 * @param {object} [options={}] - Save options.
 * @param {boolean} [options.overwrite=false] - Whether to allow overwriting an existing definition.
 * @param {boolean} [options.persist=true] - Whether to persist to the database.
 * @returns {Promise<object>} Saved definition metadata.
 */
export async function saveVmConfig({ config, sshPublicKey, setupScript }, options = {}) {
  const { overwrite = false, persist = true } = options;
  const effectiveConfig = cloneDefinition(config);
  const vmName = effectiveConfig.vm.name;

  if (!overwrite && await vmDefinitionExists(vmName)) {
    throw createConflictError(`VM name is already in use by a saved definition: ${vmName}`);
  }

  // Reject file-backed config paths for API-managed VMs
  if (effectiveConfig.vm.ssh_key_file) {
    throw createValidationError(
      'config.vm.ssh_key_file is not supported for API-managed VMs; provide sshPublicKey instead',
    );
  }
  delete effectiveConfig.vm.ssh_key_file;

  if (effectiveConfig.scripts?.setup_script_file) {
    throw createValidationError(
      'config.scripts.setup_script_file is not supported for API-managed VMs; provide setupScript instead',
    );
  }
  if (effectiveConfig.scripts) {
    delete effectiveConfig.scripts.setup_script_file;
    if (Object.keys(effectiveConfig.scripts).length === 0) {
      delete effectiveConfig.scripts;
    }
  }

  if (effectiveConfig.paths && Object.keys(effectiveConfig.paths).length === 0) {
    delete effectiveConfig.paths;
  }

  const rawConfig = yaml.dump(effectiveConfig, { lineWidth: -1 });

  let vmDefinitionId = null;
  if (persist) {
    const vmDefinition = await upsertStoredVmDefinition({
      vm_name: vmName,
      owner_user_id: effectiveConfig.vm.owner_user_id || null,
      network_group_id: effectiveConfig.vm.network_group_id || null,
      target_host_id: process.env.HOST_ID || 'local',
      config: effectiveConfig,
      ssh_public_key: sshPublicKey ? `${sshPublicKey.trim()}\n` : null,
      setup_script: setupScript ? `${setupScript.trim()}\n` : null,
    });
    vmDefinitionId = vmDefinition.id;
  }

  return {
    vmName,
    vmDefinitionId,
    keyPath: null,
    scriptPath: null,
    configPath: null,
    rawConfig,
    config: effectiveConfig,
  };
}

/**
 * Load one saved VM definition from the database.
 *
 * @param {string} vmName - VM name.
 * @returns {Promise<object>} Saved definition metadata and parsed config.
 */
export async function loadStoredConfig(vmName) {
  const vmDefinition = await loadStoredVmDefinitionByName(vmName).catch(() => null);
  if (!vmDefinition) {
    throw createNotFoundError(`Stored definition was not found for VM: ${vmName}`);
  }

  const config = vmDefinition.config || {};
  const rawConfig = yaml.dump(config, { lineWidth: -1 });

  return {
    vmName,
    configPath: null,
    rawConfig,
    config,
    vmDefinitionId: vmDefinition.id,
  };
}

/**
 * List all saved VM definition names.
 *
 * @returns {Promise<string[]>} Sorted saved VM names.
 */
export async function listStoredConfigNames() {
  const vmDefinitions = await listStoredVmDefinitions().catch(() => []);
  return vmDefinitions
    .map((entry) => entry.vm_name)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Delete VM definition from database.
 *
 * For API-managed VMs, this removes the VM definition from the database.
 * There are no file-based artifacts to clean up.
 *
 * @param {{vmName?: string, vmDefinitionId?: number}} savedConfig - Saved definition metadata.
 * @returns {Promise<void>} Resolves after definition is removed.
 */
export async function deleteSavedConfigArtifacts(savedConfig) {
  if (savedConfig?.vmName) {
    await deleteStoredVmDefinition(savedConfig.vmName).catch((error) => {
      if (error?.statusCode !== 404) {
        throw error;
      }
    });
  }

  return;
}

/**
 * Check whether a VM definition exists (alias for vmDefinitionExists).
 *
 * @param {string} vmName - VM name.
 * @returns {Promise<boolean>} Whether the definition exists.
 */
export async function storedConfigExists(vmName) {
  return vmDefinitionExists(vmName);
}

/**
 * Placeholder for config path resolution (no longer applicable for DB-backed definitions).
 * 
 * This function is kept for API compatibility but always returns null
 * since API-managed VMs do not have file-based config paths.
 *
 * @param {string} _vmName - VM name (unused, for API compatibility).
 * @returns {string|null} Always returns null for DB-backed definitions.
 */
export function configPathForVm(_vmName) {
  return null;
}

/**
 * Prepare VM config for saving (compatibility function).
 * 
 * This is a pass-through for now since validation happens in saveVmConfig.
 * 
 * @param {object} config - VM config object.
 * @returns {object} Prepared config object.
 */
export function prepareVmConfigForSave(config) {
  return config;
}
