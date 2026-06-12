import { spawn } from 'node:child_process';
import path from 'node:path';

import { apiRoot, getVmLogPath, provisionerRoot } from './config-store.js';

const bridgePath = path.join(apiRoot, 'bridge', 'hlvmp_bridge.py');
const pythonBin = process.env.HLVMP_PYTHON_BIN || 'python3';

/**
 * Create an Error object with an attached HTTP status code.
 *
 * @param {string} message - Human-readable error message.
 * @param {number} statusCode - HTTP status code.
 * @param {object|null} [details=null] - Optional structured error details.
 * @returns {Error} Decorated error instance.
 */
function createCommandError(message, statusCode, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

/**
 * Parse structured JSON bridge output from stdout or stderr.
 *
 * @param {string} stdout - Captured standard output.
 * @param {string} stderr - Captured standard error.
 * @returns {object|null} Parsed JSON payload when present.
 */
function parseBridgeOutput(stdout, stderr) {
  for (const value of [stdout.trim(), stderr.trim()]) {
    if (!value) {
      continue;
    }

    try {
      return JSON.parse(value);
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Map a bridge-side error type to an HTTP status code.
 *
 * @param {string} errorType - Bridge error type.
 * @param {string} command - Bridge command name.
 * @returns {number} HTTP status code.
 */
function mapBridgeErrorToStatus(errorType, command) {
  if (errorType === 'ValueError') {
    return 400;
  }

  if (errorType === 'FileNotFoundError') {
    return ['inspect', 'start', 'stop', 'clone', 'snapshot-create', 'snapshot-restore', 'snapshot-delete'].includes(command)
      ? 404
      : 422;
  }

  if (errorType === 'RuntimeError' || errorType === 'VmLifecycleLockError') {
    return 409;
  }

  return 500;
}

/**
 * Run a Python bridge command and parse its JSON output.
 *
 * @param {string} command - Bridge command name.
 * @param {...string} values - Optional command arguments.
 * @returns {Promise<object>} Parsed bridge payload.
 */
export function runBridgeCommand(command, ...values) {
  return new Promise((resolve, reject) => {
    const args = [bridgePath, command, ...values.filter(Boolean)];

    const child = spawn(pythonBin, args, {
      cwd: provisionerRoot,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(createCommandError(error.message, 500));
    });

    child.on('close', (code) => {
      const payload = parseBridgeOutput(stdout, stderr);
      if (code === 0) {
        resolve(payload || { success: true, output: stdout.trim() });
        return;
      }

      const errorType = payload?.error?.type || 'BridgeError';
      const message = payload?.error?.message || stderr.trim() || stdout.trim() || `Bridge command failed: ${command}`;
      reject(createCommandError(
        message,
        mapBridgeErrorToStatus(errorType, command),
        payload?.error?.details || payload,
      ));
    });
  });
}

/**
 * Provision a VM from a saved config path.
 *
 * @param {string} configPath - Saved config path.
 * @returns {Promise<object>} Bridge response payload.
 */
export async function createVm(configPath) {
  return runBridgeCommand('create', configPath);
}

/**
 * Destroy a VM by name.
 *
 * @param {string} vmName - VM name.
 * @returns {Promise<object>} Bridge response payload.
 */
export async function destroyVm(vmName) {
  return runBridgeCommand('destroy', vmName);
}

/**
 * Start a VM by name.
 *
 * @param {string} vmName - VM name.
 * @returns {Promise<object>} Bridge response payload.
 */
export async function startVm(vmName) {
  return runBridgeCommand('start', vmName);
}

/**
 * Stop a VM by name.
 *
 * @param {string} vmName - VM name.
 * @returns {Promise<object>} Bridge response payload.
 */
export async function stopVm(vmName) {
  return runBridgeCommand('stop', vmName);
}

/**
 * Clone a VM disk into a new VM defined by a saved config path.
 *
 * @param {string} sourceVmName - Source VM name.
 * @param {string} configPath - Saved target config path.
 * @returns {Promise<object>} Bridge response payload.
 */
export async function cloneVm(sourceVmName, configPath) {
  return runBridgeCommand('clone', sourceVmName, configPath);
}

/**
 * Create a restore point for a VM.
 *
 * @param {string} vmName - VM name.
 * @returns {Promise<object>} Bridge response payload.
 */
export async function createVmSnapshot(vmName) {
  return runBridgeCommand('snapshot-create', vmName);
}

/**
 * Restore a VM from a restore point.
 *
 * @param {string} vmName - VM name.
 * @param {string} snapshotId - Snapshot identifier.
 * @returns {Promise<object>} Bridge response payload.
 */
export async function restoreVmSnapshot(vmName, snapshotId) {
  return runBridgeCommand('snapshot-restore', vmName, snapshotId);
}

/**
 * Delete a restore point.
 *
 * @param {string} vmName - VM name.
 * @param {string} snapshotId - Snapshot identifier.
 * @returns {Promise<object>} Bridge response payload.
 */
export async function deleteVmSnapshot(vmName, snapshotId) {
  return runBridgeCommand('snapshot-delete', vmName, snapshotId);
}

/**
 * List configured VM snapshots via the bridge.
 *
 * @returns {Promise<object[]>} VM inventory payload.
 */
export async function listVms() {
  const payload = await runBridgeCommand('list');
  return payload.vms || [];
}

/**
 * List all libvirt VM names visible on the host.
 *
 * @returns {Promise<string[]>} Host libvirt VM names.
 */
export async function listHostVmNames() {
  const payload = await runBridgeCommand('host-list');
  return payload.vms || [];
}

/**
 * Inspect one VM through the Python bridge.
 *
 * @param {string} vmName - VM name.
 * @returns {Promise<object>} VM detail payload.
 */
export async function inspectVm(vmName) {
  const payload = await runBridgeCommand('inspect', vmName);
  return payload.vm;
}

/**
 * Ensure a log path exists and is readable through sudo.
 *
 * @param {string} logPath - Absolute QEMU log path.
 * @returns {Promise<void>} Resolves when the path exists.
 */
function ensurePrivilegedLogPath(logPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', ['-n', 'test', '-f', logPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(createCommandError(error.message, 500));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const message = stderr.trim();
      if (message.includes('a password is required')) {
        reject(createCommandError('Sudo authorization for log access has expired. Restart the API from an interactive terminal or refresh sudo with `sudo -v`.', 503));
        return;
      }

      reject(createCommandError(`VM log was not found: ${logPath}`, 404));
    });
  });
}

/**
 * Read a privileged snapshot of VM logs.
 *
 * @param {string} vmName - VM name.
 * @param {number} [lines=200] - Number of lines to read.
 * @returns {Promise<string>} Log snapshot text.
 */
export async function readVmLog(vmName, lines = 200) {
  const logPath = getVmLogPath(vmName);
  await ensurePrivilegedLogPath(logPath);

  return new Promise((resolve, reject) => {
    const child = spawn('sudo', ['-n', 'tail', '-n', String(lines), logPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(createCommandError(error.message, 500));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      if (stderr.includes('a password is required')) {
        reject(createCommandError('Sudo authorization for log access has expired. Restart the API from an interactive terminal or refresh sudo with `sudo -v`.', 503));
        return;
      }

      reject(createCommandError(stderr.trim() || `Failed to read log for ${vmName}`, 500));
    });
  });
}

/**
 * Stream privileged VM logs to an Express response using Server-Sent Events.
 *
 * @param {string} vmName - VM name.
 * @param {import('express').Response} response - Express response object.
 * @param {number} [lines=100] - Number of initial lines to replay.
 * @returns {Promise<void>} Resolves when the stream is attached.
 */
export async function streamVmLog(vmName, response, lines = 100) {
  const logPath = getVmLogPath(vmName);
  await ensurePrivilegedLogPath(logPath);

  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders();

  const child = spawn('sudo', ['-n', 'tail', '-n', String(lines), '-F', logPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const keepAlive = setInterval(() => {
    response.write(': keep-alive\n\n');
  }, 15000);

  child.stdout.on('data', (chunk) => {
    response.write(`event: log\ndata: ${JSON.stringify({ chunk: chunk.toString() })}\n\n`);
  });

  child.stderr.on('data', (chunk) => {
    const message = chunk.toString();
    response.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);

    if (message.includes('a password is required')) {
      response.end();
    }
  });

  const cleanup = () => {
    clearInterval(keepAlive);
    child.kill('SIGTERM');
  };

  child.on('close', () => {
    clearInterval(keepAlive);
    response.end();
  });

  response.on('close', cleanup);
}
