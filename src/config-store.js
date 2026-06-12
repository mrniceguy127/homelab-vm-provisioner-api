import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const apiRoot = path.resolve(__dirname, '..');
export const provisionerRoot = process.env.HLVMP_PROVISIONER_DIR || path.join(apiRoot, 'homelab-vm-provisioner');
export const legacyRuntimeRoot = process.env.HLVMP_API_RUNTIME_DIR || path.join(apiRoot, 'runtime');
export const legacyConfigRoot = path.join(legacyRuntimeRoot, 'configs');
export const legacyUserKeyRoot = path.join(legacyRuntimeRoot, 'keys', 'users');
export const legacyVmDataRoot = path.join(legacyRuntimeRoot, 'vm-data');
export const configRoot = path.join(provisionerRoot, 'configs');
export const userKeyRoot = path.join(provisionerRoot, 'vm', 'keys', 'users');
export const vmDataRoot = path.join(provisionerRoot, 'vm', 'data');

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
function sanitizeFileName(value, fallback) {
  const baseName = path.basename(value || fallback);
  const sanitized = baseName.replace(/[^A-Za-z0-9._-]/g, '-');
  return sanitized || fallback;
}

/**
 * Deep-clone a JSON-compatible config object.
 *
 * @param {object} config - Config object to clone.
 * @returns {object} Deep-cloned config object.
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
  try {
    await fs.access(configPathForVm(vmName));
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
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
  await Promise.all([
    fs.mkdir(configRoot, { recursive: true }),
    fs.mkdir(userKeyRoot, { recursive: true }),
    fs.mkdir(vmDataRoot, { recursive: true }),
  ]);
}

/**
 * Save a VM config using the provisioner's default storage paths.
 *
 * @param {{config: object, sshPublicKey?: string}} payload - Save request payload.
 * @param {object} [options={}] - Save options.
 * @param {boolean} [options.overwrite=false] - Whether to allow overwriting an existing config.
 * @returns {Promise<object>} Saved config metadata.
 */
export async function saveVmConfig({ config, sshPublicKey }, options = {}) {
  const { overwrite = false } = options;
  const effectiveConfig = cloneConfig(config);
  const vmName = effectiveConfig.vm.name;

  await ensureRuntimeDirectories();

  const configPath = configPathForVm(vmName);
  if (!overwrite && await storedConfigExists(vmName)) {
    throw createConflictError(`VM name is already in use by a saved config: ${vmName}`);
  }

  if (effectiveConfig.paths && Object.keys(effectiveConfig.paths).length === 0) {
    delete effectiveConfig.paths;
  }

  let keyPath = null;
  if (sshPublicKey) {
    const requestedKeyFile = effectiveConfig.vm.ssh_key_file || `${vmName}.pub`;
    const keyFileName = sanitizeFileName(requestedKeyFile, `${vmName}.pub`);
    keyPath = path.join(userKeyRoot, keyFileName);
    await fs.writeFile(keyPath, `${sshPublicKey.trim()}\n`, 'utf8');
    effectiveConfig.vm.ssh_key_file = keyPath;
  } else if (effectiveConfig.vm.ssh_key_file) {
    if (!path.isAbsolute(effectiveConfig.vm.ssh_key_file)) {
      throw createValidationError(
        'config.vm.ssh_key_file must be an absolute path when sshPublicKey is not provided',
      );
    }

    try {
      await fs.access(effectiveConfig.vm.ssh_key_file);
    } catch {
      throw createValidationError(
        `Referenced SSH public key was not found: ${effectiveConfig.vm.ssh_key_file}`,
      );
    }
  }

  const rawConfig = yaml.dump(effectiveConfig, { lineWidth: -1 });
  await fs.writeFile(configPath, rawConfig, 'utf8');

  return {
    vmName,
    keyPath,
    configPath,
    rawConfig,
    config: effectiveConfig,
  };
}

/**
 * Load one saved VM config.
 *
 * @param {string} vmName - VM name.
 * @returns {Promise<object>} Saved config metadata and parsed YAML.
 */
export async function loadStoredConfig(vmName) {
  const configPath = configPathForVm(vmName);

  let rawConfig;
  try {
    rawConfig = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw createNotFoundError(`Stored config was not found for VM: ${vmName}`);
    }

    throw error;
  }

  return {
    vmName,
    configPath,
    rawConfig,
    config: yaml.load(rawConfig),
  };
}

/**
 * List all saved VM config names.
 *
 * @returns {Promise<string[]>} Sorted saved VM names.
 */
export async function listStoredConfigNames() {
  try {
    const entries = await fs.readdir(configRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
      .map((entry) => entry.name.replace(/\.ya?ml$/, ''))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}
