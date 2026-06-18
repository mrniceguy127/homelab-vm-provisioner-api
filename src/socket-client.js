/**
 * Unix socket client for waking the worker daemon
 * 
 * Provides a lightweight mechanism to notify colocated workers
 * about new jobs without relying solely on polling.
 */

import net from 'net';

/**
 * Send a message to the worker Unix socket
 * 
 * @param {string} socketPath - Path to the Unix socket
 * @param {string} message - Message to send (e.g., 'wake', 'health')
 * @param {object} options - Options
 * @param {number} options.timeout - Connection timeout in milliseconds (default: 1000)
 * @returns {Promise<string>} Response from the socket
 */
export function sendSocketMessage(socketPath, message, { timeout = 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ path: socketPath });
    let response = '';
    let resolved = false;

    // Set timeout
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        client.destroy();
        reject(new Error(`Socket connection timeout after ${timeout}ms`));
      }
    }, timeout);

    client.on('connect', () => {
      client.write(message + '\n');
    });

    client.on('data', (data) => {
      response += data.toString();
    });

    client.on('end', () => {
      clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        resolve(response.trim());
      }
    });

    client.on('error', (err) => {
      clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
  });
}

/**
 * Wake the worker daemon via Unix socket
 * 
 * This is a best-effort operation. If the socket is not available
 * or the wake fails, the error is logged but not propagated.
 * Workers have fallback polling so jobs will still be processed.
 * 
 * @param {string|null} socketPath - Path to worker socket (null = disabled)
 * @param {object} options - Options
 * @param {object} options.logger - Logger instance
 * @returns {Promise<boolean>} True if wake succeeded, false otherwise
 */
export async function wakeWorker(socketPath, { logger = console } = {}) {
  if (!socketPath) {
    logger.debug?.('Worker socket not configured, skipping wake');
    return false;
  }

  try {
    const response = await sendSocketMessage(socketPath, 'wake', { timeout: 1000 });
    if (response === 'OK') {
      logger.debug?.(`Worker wakeup sent to ${socketPath}`);
      return true;
    } else {
      logger.warn(`Unexpected worker wakeup response: ${response}`);
      return false;
    }
  } catch (err) {
    logger.debug?.(`Worker wakeup failed: ${err.message}`);
    return false;
  }
}

/**
 * Query worker health via Unix socket
 * 
 * @param {string} socketPath - Path to worker socket
 * @param {object} options - Options
 * @param {number} options.timeout - Connection timeout in milliseconds
 * @returns {Promise<object>} Worker health data
 */
export async function getWorkerHealth(socketPath, { timeout = 1000 } = {}) {
  const response = await sendSocketMessage(socketPath, 'health', { timeout });
  return JSON.parse(response);
}
