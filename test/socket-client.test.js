/**
 * Tests for Unix socket client
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sendSocketMessage, wakeWorker, getWorkerHealth } from '../src/socket-client.js';

describe('socket-client', () => {
  let socketPath;
  let mockServer;
  
  beforeEach(() => {
    // Create temporary socket path
    socketPath = path.join(os.tmpdir(), `test-socket-${Date.now()}.sock`);
  });
  
  afterEach(() => {
    // Clean up server
    if (mockServer) {
      mockServer.close();
      mockServer = null;
    }
    
    // Clean up socket file
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  });
  
  function createMockServer(handler) {
    const server = net.createServer((socket) => {
      socket.on('data', (data) => {
        const message = data.toString().trim();
        const response = handler(message);
        if (response) {
          socket.write(response);
        }
        socket.end();
      });
    });
    
    server.listen(socketPath);
    return server;
  }
  
  describe('sendSocketMessage', () => {
    it('should send message and receive response', async () => {
      mockServer = createMockServer((message) => {
        expect(message).toBe('wake');
        return 'OK';
      });
      
      const response = await sendSocketMessage(socketPath, 'wake');
      expect(response).toBe('OK');
    });
    
    it('should handle JSON responses', async () => {
      mockServer = createMockServer((message) => {
        expect(message).toBe('health');
        return JSON.stringify({ status: 'ok', worker_id: 'test-worker' });
      });
      
      const response = await sendSocketMessage(socketPath, 'health');
      expect(response).toBe('{"status":"ok","worker_id":"test-worker"}');
    });
    
    it('should timeout on slow connections', async () => {
      mockServer = createMockServer((_message) => {
        // Delay response - socket will timeout before response is sent
        // Don't send response immediately, let timeout occur
      });
      
      // Replace server with one that delays
      mockServer.close();
      mockServer = net.createServer((socket) => {
        socket.on('data', () => {
          // Don't respond, let the client timeout
          // Keep socket open but don't write anything
        });
      });
      mockServer.listen(socketPath);
      
      await expect(
        sendSocketMessage(socketPath, 'wake', { timeout: 100 })
      ).rejects.toThrow('timeout');
    });
    
    it('should reject on connection error', async () => {
      // No server listening
      await expect(
        sendSocketMessage('/nonexistent/socket.sock', 'wake', { timeout: 100 })
      ).rejects.toThrow();
    });
  });
  
  describe('wakeWorker', () => {
    it('should return false when socket path is null', async () => {
      const mockLogger = { debug: vi.fn() };
      
      const result = await wakeWorker(null, { logger: mockLogger });
      
      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('not configured')
      );
    });
    
    it('should return true on successful wake', async () => {
      mockServer = createMockServer((message) => {
        expect(message).toBe('wake');
        return 'OK';
      });
      
      const mockLogger = { debug: vi.fn() };
      
      const result = await wakeWorker(socketPath, { logger: mockLogger });
      
      expect(result).toBe(true);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('wakeup sent')
      );
    });
    
    it('should return false on unexpected response', async () => {
      mockServer = createMockServer((_message) => {
        return 'UNEXPECTED';
      });
      
      const mockLogger = { warn: vi.fn() };
      
      const result = await wakeWorker(socketPath, { logger: mockLogger });
      
      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Unexpected')
      );
    });
    
    it('should return false on connection failure', async () => {
      // No server listening
      const mockLogger = { debug: vi.fn() };
      
      const result = await wakeWorker('/nonexistent/socket.sock', { logger: mockLogger });
      
      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('failed')
      );
    });
    
    it('should not throw on failure', async () => {
      // Should handle errors gracefully
      await expect(
        wakeWorker('/nonexistent/socket.sock')
      ).resolves.toBe(false);
    });
  });
  
  describe('getWorkerHealth', () => {
    it('should return parsed health data', async () => {
      mockServer = createMockServer((message) => {
        expect(message).toBe('health');
        return JSON.stringify({
          status: 'ok',
          worker_id: 'test-worker',
          concurrency: 2,
          active_jobs: 1,
          available_slots: 1,
        });
      });
      
      const health = await getWorkerHealth(socketPath);
      
      expect(health).toEqual({
        status: 'ok',
        worker_id: 'test-worker',
        concurrency: 2,
        active_jobs: 1,
        available_slots: 1,
      });
    });
    
    it('should reject on connection failure', async () => {
      await expect(
        getWorkerHealth('/nonexistent/socket.sock', { timeout: 100 })
      ).rejects.toThrow();
    });
    
    it('should reject on invalid JSON', async () => {
      mockServer = createMockServer(() => {
        return 'NOT JSON';
      });
      
      await expect(
        getWorkerHealth(socketPath)
      ).rejects.toThrow();
    });
  });
});
