import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import yaml from 'js-yaml';

import {
  configRoot,
  legacyConfigRoot,
  legacyRuntimeRoot,
  legacyUserKeyRoot,
  legacyVmDataRoot,
  provisionerRoot,
  userKeyRoot,
  vmDataRoot,
} from './config-store.js';

const SUDO_KEEPALIVE_INTERVAL_MS = 60 * 1000;

/**
 * Check whether a file system path exists while tolerating missing paths.
 *
 * @param {string} filePath - File or directory path.
 * @returns {Promise<boolean>} Whether the path exists.
 */
function pathExistsErrorTolerant(filePath) {
  return fs.stat(filePath)
    .then(() => true)
    .catch((error) => {
      if (error && error.code === 'ENOENT') {
        return false;
      }

      return true;
    });
}

/**
 * Spawn a command and capture or inherit its output.
 *
 * @param {string} command - Executable name.
 * @param {string[]} args - Command arguments.
 * @param {object} [options={}] - Spawn options.
 * @returns {Promise<{code:number,stdout:string,stderr:string}>} Command result.
 */
function runCommand(command, args, options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    stdio = ['ignore', 'pipe', 'pipe'],
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio });

    if (stdio === 'inherit') {
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({ code, stdout: '', stderr: '' });
      });
      return;
    }

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Ensure sudo credentials are available for later libvirt operations.
 *
 * @returns {Promise<void>} Resolves when sudo credentials are available.
 */
async function ensureSudoCredentials() {
  const cached = await runCommand('sudo', ['-n', '-v']);
  if (cached.code === 0) {
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Sudo access is required for virsh/libvirt operations. Start the API from an interactive terminal so sudo can prompt securely, or pre-authorize sudo with `sudo -v` first.',
    );
  }

  console.log('Confirm sudo access for virsh/libvirt operations.');
  const prompted = await runCommand('sudo', ['-v'], { stdio: 'inherit' });
  if (prompted.code !== 0) {
    throw new Error('Unable to acquire sudo credentials for virsh/libvirt operations.');
  }
}

/**
 * Refresh the sudo timestamp periodically while the API is running.
 *
 * @returns {void}
 */
function startSudoKeepAlive() {
  const timer = setInterval(async () => {
    try {
      await runCommand('sudo', ['-n', '-v']);
    } catch {
      // Keep the server running even if the sudo timestamp expires.
    }
  }, SUDO_KEEPALIVE_INTERVAL_MS);

  timer.unref?.();
}

/**
 * Determine whether a path is inside a parent directory.
 *
 * @param {string} targetPath - Path to test.
 * @param {string} parentPath - Candidate parent directory.
 * @returns {boolean} Whether the target is inside the parent path.
 */
function pathIsInside(targetPath, parentPath) {
  const relativePath = path.relative(parentPath, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

/**
 * List directory entries while tolerating missing directories.
 *
 * @param {string} directoryPath - Directory path.
 * @returns {Promise<import('node:fs').Dirent[]>} Directory entries.
 */
async function listDirectoryEntries(directoryPath) {
  try {
    return await fs.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

/**
 * Move a file system entry into place when the destination does not exist.
 *
 * @param {string} sourcePath - Existing source path.
 * @param {string} targetPath - Destination path.
 * @returns {Promise<void>} Resolves after the move when required.
 */
async function moveEntryIfMissing(sourcePath, targetPath) {
  if (!await pathExistsErrorTolerant(sourcePath)) {
    return;
  }

  if (await pathExistsErrorTolerant(targetPath)) {
    return;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.rename(sourcePath, targetPath);
}

/**
 * Rewrite migrated configs so they point at provisioner-default directories.
 *
 * @param {string} configPath - Saved config file path.
 * @returns {Promise<void>} Resolves after the config is normalized.
 */
async function normalizeMigratedConfig(configPath) {
  const rawConfig = await fs.readFile(configPath, 'utf8');
  const config = yaml.load(rawConfig) || {};
  const vmName = String(config?.vm?.name || '').trim();

  if (config?.vm?.ssh_key_file && path.isAbsolute(config.vm.ssh_key_file)) {
    const absoluteKeyPath = path.resolve(config.vm.ssh_key_file);
    if (pathIsInside(absoluteKeyPath, legacyUserKeyRoot)) {
      config.vm.ssh_key_file = path.join(userKeyRoot, path.basename(absoluteKeyPath));
    }
  }

  if (config?.paths?.vm_data_dir && path.isAbsolute(config.paths.vm_data_dir)) {
    const absoluteVmDataPath = path.resolve(config.paths.vm_data_dir);
    if (pathIsInside(absoluteVmDataPath, legacyVmDataRoot)) {
      delete config.paths.vm_data_dir;
    }
  }

  if (vmName && (!config.paths || Object.keys(config.paths).length === 0)) {
    delete config.paths;
  }

  await fs.writeFile(configPath, yaml.dump(config, { lineWidth: -1 }), 'utf8');
}

/**
 * Migrate legacy API-managed files into provisioner-default directories.
 *
 * @returns {Promise<void>} Resolves after migration completes.
 */
async function migrateLegacyRuntimeData() {
  await Promise.all([
    fs.mkdir(configRoot, { recursive: true }),
    fs.mkdir(userKeyRoot, { recursive: true }),
    fs.mkdir(vmDataRoot, { recursive: true }),
  ]);

  const legacyConfigEntries = await listDirectoryEntries(legacyConfigRoot);
  for (const entry of legacyConfigEntries) {
    if (!entry.isFile()) {
      continue;
    }

    const sourcePath = path.join(legacyConfigRoot, entry.name);
    const targetPath = path.join(configRoot, entry.name);
    await moveEntryIfMissing(sourcePath, targetPath);
    if (await pathExistsErrorTolerant(targetPath)) {
      await normalizeMigratedConfig(targetPath);
    }
  }

  const legacyKeyEntries = await listDirectoryEntries(legacyUserKeyRoot);
  for (const entry of legacyKeyEntries) {
    const sourcePath = path.join(legacyUserKeyRoot, entry.name);
    const targetPath = path.join(userKeyRoot, entry.name);
    await moveEntryIfMissing(sourcePath, targetPath);
  }

  const legacyVmDataEntries = await listDirectoryEntries(legacyVmDataRoot);
  for (const entry of legacyVmDataEntries) {
    const sourcePath = path.join(legacyVmDataRoot, entry.name);
    const targetPath = path.join(vmDataRoot, entry.name);
    await moveEntryIfMissing(sourcePath, targetPath);
  }
}

/**
 * Repair ownership for provisioner and API-managed directories.
 *
 * @returns {Promise<void>} Resolves when ownership matches the running user.
 */
async function repairOwnership() {
  const ownershipTargets = [
    legacyRuntimeRoot,
    path.join(provisionerRoot, 'configs'),
    path.join(provisionerRoot, 'vm'),
  ];

  const existingTargets = [];
  for (const target of ownershipTargets) {
    if (await pathExistsErrorTolerant(target)) {
      existingTargets.push(target);
    }
  }

  if (existingTargets.length === 0) {
    return;
  }

  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    return;
  }

  const result = await runCommand('sudo', ['-n', 'chown', '-R', `${uid}:${gid}`, ...existingTargets]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'Unable to repair API file ownership.');
  }
}

/**
 * Initialize privilege support before the API starts accepting requests.
 *
 * @returns {Promise<void>} Resolves after sudo credentials and ownership are prepared.
 */
export async function initializePrivilegeSupport() {
  const uid = process.getuid?.();
  if (uid === 0) {
    throw new Error(
      'Do not run the API as root. Start it as your normal user and let it request sudo only for virsh/libvirt operations.',
    );
  }

  await ensureSudoCredentials();
  await repairOwnership();
  await migrateLegacyRuntimeData();
  startSudoKeepAlive();
}
