import path from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';

import {
  deleteStoredVmDefinition,
  listStoredVmDefinitions,
  loadStoredVmDefinitionByName,
  upsertStoredVmDefinition,
} from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const apiRoot = path.resolve(__dirname, '..');
export const workspaceRoot = path.resolve(apiRoot, '..');

function resolveProvisionerRoot() {
  const configuredRoot = process.env.PROVISIONER_CLI_PATH;
  if (!configuredRoot) {
    return path.join(workspaceRoot, 'homelab-vm-provisioner-cli');
  }

  return path.isAbsolute(configuredRoot)
    ? configuredRoot
    : path.join(workspaceRoot, configuredRoot);
}

export const provisionerRoot = resolveProvisionerRoot();
export const provisionerDataRoot = path.isAbsolute(process.env.PROVISIONER_DATA_DIR || '')
  ? path.resolve(process.env.PROVISIONER_DATA_DIR)
  : path.join(provisionerRoot, process.env.PROVISIONER_DATA_DIR || 'data');
export const legacyRuntimeRoot = process.env.HLVMP_API_RUNTIME_DIR || path.join(apiRoot, 'runtime');
export const legacyConfigRoot = path.join(legacyRuntimeRoot, 'configs');
export const legacyUserKeyRoot = path.join(legacyRuntimeRoot, 'keys', 'users');
export const legacyVmDataRoot = path.join(legacyRuntimeRoot, 'vm-data');
export const configRoot = path.join(provisionerDataRoot, 'configs');
export const userKeyRoot = path.join(provisionerDataRoot, 'vm', 'keys', 'users');
export const vmDataRoot = path.join(provisionerDataRoot, 'vm', 'data');
export const scriptRoot = path.join(provisionerDataRoot, 'vm', 'scripts');

/**
 * Create an HTTP 422 validation error.
 *
 * @param {string} message - Validation error message.
 * @param {Array<object>} [details=[]] - Optional validation detail list.
 * @returns {Error} Error tagged with `statusCode` 422.
 */
function createValidationError(message, details = []) {
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
function createConflictError(message) {
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
function createNotFoundError(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

/**
 * Sanitize a file name for local storage.
 *
 * @param {string} value - Requested file name.
 * @param {string} fallback - Fallback file name.
 * @returns {string} Safe file name.
 */
function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config));
}

/**
 * Resolve the saved config path for a VM name.
 *
 * @param {string} vmName - VM name.
 * @returns {string} Absolute config file path.
 */
export function configPathForVm(vmName) {
  return path.join(configRoot, `${vmName}.yaml`);
}

/**
 * Determine whether a saved config already exists for a VM.
 *
 * @param {string} vmName - VM name.
 * @returns {Promise<boolean>} Whether the saved config file exists.
 */
export async function storedConfigExists(vmName) {
  return Boolean(await loadStoredVmDefinitionByName(vmName).catch(() => null));
}

/**
 * Resolve the host QEMU log path for a VM.
 *
 * @param {string} vmName - VM name.
 * @returns {string} Absolute QEMU log file path.
 */
export function getVmLogPath(vmName) {
  return path.join('/var/log/libvirt/qemu', `${vmName}.log`);
}

/**
 * Ensure provisioner-backed storage directories exist.
 *
 * @returns {Promise<void>} Resolves when the directories exist.
 */
export async function ensureRuntimeDirectories() {
  return;
}

/**
 * Save a VM config using the provisioner's default storage paths.
 *
 * @param {{config: object, sshPublicKey?: string, setupScript?: string}} payload - Save request payload.
 * @param {object} [options={}] - Save options.
 * @param {boolean} [options.overwrite=false] - Whether to allow overwriting an existing config.
 * @returns {Promise<object>} Saved config metadata.
 */
export async function saveVmConfig({ config, sshPublicKey, setupScript }, options = {}) {
  const { overwrite = false, persist = true } = options;
  const effectiveConfig = cloneConfig(config);
  const vmName = effectiveConfig.vm.name;

  if (!overwrite && await storedConfigExists(vmName)) {
    throw createConflictError(`VM name is already in use by a saved config: ${vmName}`);
  }

  if (effectiveConfig.paths && Object.keys(effectiveConfig.paths).length === 0) {
    delete effectiveConfig.paths;
  }

  if (effectiveConfig.scripts && Object.keys(effectiveConfig.scripts).length === 0) {
    delete effectiveConfig.scripts;
  }

  let sshPublicKeyContent = null;
  if (sshPublicKey) {
    sshPublicKeyContent = `${sshPublicKey.trim()}\n`;
  } else if (effectiveConfig.vm.ssh_key_file) {
    throw createValidationError(
      'config.vm.ssh_key_file is not supported for API-managed VMs; provide sshPublicKey instead',
    );
  }
  delete effectiveConfig.vm.ssh_key_file;

  let setupScriptContent = null;
  if (setupScript) {
    setupScriptContent = `${setupScript.trim()}\n`;
  } else if (effectiveConfig.scripts?.setup_script_file) {
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

  const rawConfig = yaml.dump(effectiveConfig, { lineWidth: -1 });

  const vmDefinition = persist ? await upsertStoredVmDefinition({
    vm_name: vmName,
    owner_user_id: effectiveConfig.vm.owner_user_id || null,
    network_group_id: effectiveConfig.vm.network_group_id || null,
    target_host_id: process.env.HOST_ID || 'local',
    config: effectiveConfig,
    ssh_public_key: sshPublicKeyContent,
    setup_script: setupScriptContent,
  }) : null;

  return {
    vmName,
    vmDefinitionId: vmDefinition?.id || null,
    keyPath: null,
    scriptPath: null,
    configPath: null,
    rawConfig,
    config: effectiveConfig,
  };
}

/**
 * Delete files created while saving a VM config.
 *
 * This is used to roll back `POST /api/vms` when provisioning fails after the
 * config and any uploaded assets were already persisted.
 *
 * @param {{configPath?: string, keyPath?: string|null, scriptPath?: string|null}} savedConfig - Save result metadata.
 * @returns {Promise<void>} Resolves after all created files are removed.
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
 * Load one saved VM config.
 *
 * @param {string} vmName - VM name.
 * @returns {Promise<object>} Saved config metadata and parsed YAML.
 */
export async function loadStoredConfig(vmName) {
  const vmDefinition = await loadStoredVmDefinitionByName(vmName).catch(() => null);
  if (!vmDefinition) {
    throw createNotFoundError(`Stored config was not found for VM: ${vmName}`);
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
 * List all saved VM config names.
 *
 * @returns {Promise<string[]>} Sorted saved VM names.
 */
export async function listStoredConfigNames() {
  const vmDefinitions = await listStoredVmDefinitions().catch(() => []);
  return vmDefinitions
    .map((entry) => entry.vm_name)
    .sort((left, right) => left.localeCompare(right));
}
