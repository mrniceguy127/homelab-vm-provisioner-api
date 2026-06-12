import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { apiRoot, getVmLogPath, provisionerRoot } from './config-store.js';

const bridgePath = path.join(apiRoot, 'bridge', 'hlvmp_bridge.py');
const pythonBin = process.env.HLVMP_PYTHON_BIN || 'python3';

function createCommandError(message, statusCode, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

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

function mapBridgeErrorToStatus(errorType, command) {
  if (errorType === 'ValueError') {
    return 400;
  }

  if (errorType === 'FileNotFoundError') {
    return command === 'inspect' ? 404 : 422;
  }

  if (errorType === 'RuntimeError') {
    return 409;
  }

  return 500;
}

export function runBridgeCommand(command, value) {
  return new Promise((resolve, reject) => {
    const args = [bridgePath, command];
    if (value) {
      args.push(value);
    }

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
      reject(createCommandError(message, mapBridgeErrorToStatus(errorType, command), payload));
    });
  });
}

export async function createVm(configPath) {
  return runBridgeCommand('create', configPath);
}

export async function destroyVm(vmName) {
  return runBridgeCommand('destroy', vmName);
}

export async function listVms() {
  const payload = await runBridgeCommand('list');
  return payload.vms || [];
}

export async function inspectVm(vmName) {
  const payload = await runBridgeCommand('inspect', vmName);
  return payload.vm;
}

export async function readVmLog(vmName, lines = 200) {
  const logPath = getVmLogPath(vmName);

  try {
    await fs.access(logPath);
  } catch {
    throw createCommandError(`VM log was not found: ${logPath}`, 404);
  }

  return new Promise((resolve, reject) => {
    const child = spawn('tail', ['-n', String(lines), logPath], {
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

      reject(createCommandError(stderr.trim() || `Failed to read log for ${vmName}`, 500));
    });
  });
}

export async function streamVmLog(vmName, response, lines = 100) {
  const logPath = getVmLogPath(vmName);

  try {
    await fs.access(logPath);
  } catch {
    throw createCommandError(`VM log was not found: ${logPath}`, 404);
  }

  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders();

  const child = spawn('tail', ['-n', String(lines), '-F', logPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const keepAlive = setInterval(() => {
    response.write(': keep-alive\n\n');
  }, 15000);

  child.stdout.on('data', (chunk) => {
    response.write(`event: log\ndata: ${JSON.stringify({ chunk: chunk.toString() })}\n\n`);
  });

  child.stderr.on('data', (chunk) => {
    response.write(`event: error\ndata: ${JSON.stringify({ message: chunk.toString() })}\n\n`);
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
