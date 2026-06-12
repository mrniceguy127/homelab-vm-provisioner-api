import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const apiRoot = path.resolve(__dirname, '..');
export const provisionerRoot = process.env.HLVMP_PROVISIONER_DIR || path.join(apiRoot, 'homelab-vm-provisioner');
export const runtimeRoot = process.env.HLVMP_API_RUNTIME_DIR || path.join(apiRoot, 'runtime');
export const configRoot = path.join(runtimeRoot, 'configs');
export const userKeyRoot = path.join(runtimeRoot, 'keys', 'users');
export const vmDataRoot = path.join(runtimeRoot, 'vm-data');

function createValidationError(message, details = []) {
  const error = new Error(message);
  error.statusCode = 422;
  error.details = details;
  return error;
}

function createNotFoundError(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

function sanitizeFileName(value, fallback) {
  const baseName = path.basename(value || fallback);
  const sanitized = baseName.replace(/[^A-Za-z0-9._-]/g, '-');
  return sanitized || fallback;
}

function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config));
}

export function configPathForVm(vmName) {
  return path.join(configRoot, `${vmName}.yaml`);
}

export function getVmLogPath(vmName) {
  return path.join('/var/log/libvirt/qemu', `${vmName}.log`);
}

export async function ensureRuntimeDirectories() {
  await Promise.all([
    fs.mkdir(configRoot, { recursive: true }),
    fs.mkdir(userKeyRoot, { recursive: true }),
    fs.mkdir(vmDataRoot, { recursive: true }),
  ]);
}

export async function saveVmConfig({ config, sshPublicKey }) {
  const effectiveConfig = cloneConfig(config);
  const vmName = effectiveConfig.vm.name;

  await ensureRuntimeDirectories();

  effectiveConfig.paths = effectiveConfig.paths || {};
  if (!effectiveConfig.paths.vm_data_dir) {
    effectiveConfig.paths.vm_data_dir = path.join(vmDataRoot, vmName);
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

  const configPath = configPathForVm(vmName);
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
