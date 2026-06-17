import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import EventEmitter from 'node:events';

import {
  runBridgeCommand,
  createVm,
  destroyVm,
  startVm,
  stopVm,
  cloneVm,
  createVmSnapshot,
  restoreVmSnapshot,
  deleteVmSnapshot,
  inspectVm,
  reconcileVmNetworking,
  listVms,
  listHostVmNames,
} from '../src/provisioner.js';

vi.mock('node:child_process');

describe('provisioner', () => {
  let mockChild;

  beforeEach(() => {
    mockChild = new EventEmitter();
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    spawn.mockReturnValue(mockChild);
    vi.clearAllMocks();
  });

  describe('runBridgeCommand', () => {
    it('resolves with JSON payload on success', async () => {
      const promise = runBridgeCommand('test-command', 'arg1');

      mockChild.stdout.emit('data', '{"result": "success"}');
      mockChild.emit('close', 0);

      const result = await promise;
      expect(result).toEqual({ result: 'success' });
    });

    it('resolves with output when no JSON payload', async () => {
      const promise = runBridgeCommand('test-command');

      mockChild.stdout.emit('data', 'plain text output');
      mockChild.emit('close', 0);

      const result = await promise;
      expect(result).toEqual({ success: true, output: 'plain text output' });
    });

    it('rejects with error message from JSON payload', async () => {
      const promise = runBridgeCommand('test-command');

      mockChild.stderr.emit('data', JSON.stringify({
        error: {
          type: 'ValueError',
          message: 'Invalid input',
          details: { field: 'name' },
        },
      }));
      mockChild.emit('close', 1);

      await expect(promise).rejects.toMatchObject({
        message: 'Invalid input',
        statusCode: 400,
        details: { field: 'name' },
      });
    });

    it('maps ValueError to 400 status', async () => {
      const promise = runBridgeCommand('test-command');

      mockChild.stderr.emit('data', JSON.stringify({
        error: { type: 'ValueError', message: 'Bad request' },
      }));
      mockChild.emit('close', 1);

      await expect(promise).rejects.toMatchObject({ statusCode: 400 });
    });

    it('maps FileNotFoundError for inspect to 404', async () => {
      const promise = runBridgeCommand('inspect', 'missing-vm');

      mockChild.stderr.emit('data', JSON.stringify({
        error: { type: 'FileNotFoundError', message: 'VM not found' },
      }));
      mockChild.emit('close', 1);

      await expect(promise).rejects.toMatchObject({ statusCode: 404 });
    });

    it('maps FileNotFoundError for start to 404', async () => {
      const promise = runBridgeCommand('start', 'missing-vm');

      mockChild.stderr.emit('data', JSON.stringify({
        error: { type: 'FileNotFoundError', message: 'VM not found' },
      }));
      mockChild.emit('close', 1);

      await expect(promise).rejects.toMatchObject({ statusCode: 404 });
    });

    it('maps FileNotFoundError for create to 422', async () => {
      const promise = runBridgeCommand('create', 'missing-config');

      mockChild.stderr.emit('data', JSON.stringify({
        error: { type: 'FileNotFoundError', message: 'Config not found' },
      }));
      mockChild.emit('close', 1);

      await expect(promise).rejects.toMatchObject({ statusCode: 422 });
    });

    it('maps RuntimeError to 409', async () => {
      const promise = runBridgeCommand('test-command');

      mockChild.stderr.emit('data', JSON.stringify({
        error: { type: 'RuntimeError', message: 'Conflict' },
      }));
      mockChild.emit('close', 1);

      await expect(promise).rejects.toMatchObject({ statusCode: 409 });
    });

    it('maps VmLifecycleLockError to 409', async () => {
      const promise = runBridgeCommand('test-command');

      mockChild.stderr.emit('data', JSON.stringify({
        error: { type: 'VmLifecycleLockError', message: 'VM locked' },
      }));
      mockChild.emit('close', 1);

      await expect(promise).rejects.toMatchObject({ statusCode: 409 });
    });

    it('maps NetworkReconcileSafetyError to 409', async () => {
      const promise = runBridgeCommand('test-command');

      mockChild.stderr.emit('data', JSON.stringify({
        error: { type: 'NetworkReconcileSafetyError', message: 'Network conflict' },
      }));
      mockChild.emit('close', 1);

      await expect(promise).rejects.toMatchObject({ statusCode: 409 });
    });

    it('defaults unknown errors to 500', async () => {
      const promise = runBridgeCommand('test-command');

      mockChild.stderr.emit('data', JSON.stringify({
        error: { type: 'UnknownError', message: 'Internal error' },
      }));
      mockChild.emit('close', 1);

      await expect(promise).rejects.toMatchObject({ statusCode: 500 });
    });

    it('uses stderr message when no JSON payload', async () => {
      const promise = runBridgeCommand('test-command');

      mockChild.stderr.emit('data', 'stderr error message');
      mockChild.emit('close', 1);

      await expect(promise).rejects.toMatchObject({
        message: 'stderr error message',
        statusCode: 500,
      });
    });

    it('uses stdout message when stderr is empty', async () => {
      const promise = runBridgeCommand('test-command');

      mockChild.stdout.emit('data', 'stdout error message');
      mockChild.emit('close', 1);

      await expect(promise).rejects.toMatchObject({
        message: 'stdout error message',
      });
    });

    it('uses generic message when output is empty', async () => {
      const promise = runBridgeCommand('test-command');

      mockChild.emit('close', 1);

      await expect(promise).rejects.toMatchObject({
        message: 'Bridge command failed: test-command',
      });
    });

    it('rejects on spawn error', async () => {
      const promise = runBridgeCommand('test-command');

      mockChild.emit('error', new Error('Spawn failed'));

      await expect(promise).rejects.toMatchObject({
        message: 'Spawn failed',
        statusCode: 500,
      });
    });

    it('filters out empty arguments', () => {
      runBridgeCommand('test-command', 'arg1', '', 'arg2', null, 'arg3');

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['test-command', 'arg1', 'arg2', 'arg3']),
        expect.any(Object),
      );

      const actualArgs = spawn.mock.calls[0][1];
      expect(actualArgs).not.toContain('');
      expect(actualArgs).not.toContain(null);
    });

    it('sets PYTHONUNBUFFERED environment variable', () => {
      runBridgeCommand('test-command');

      const spawnOptions = spawn.mock.calls[0][2];
      expect(spawnOptions.env.PYTHONUNBUFFERED).toBe('1');
    });

    it('normalizes PATH environment variable', () => {
      process.env.PATH = '/custom/bin';

      runBridgeCommand('test-command');

      const spawnOptions = spawn.mock.calls[0][2];
      expect(spawnOptions.env.PATH).toContain('/usr/local/bin');
      expect(spawnOptions.env.PATH).toContain('/usr/bin');
      expect(spawnOptions.env.PATH).toContain('/custom/bin');
    });

    it('parses JSON from stderr when stdout is empty', async () => {
      const promise = runBridgeCommand('test-command');

      mockChild.stderr.emit('data', '{"result": "from stderr"}');
      mockChild.emit('close', 0);

      const result = await promise;
      expect(result).toEqual({ result: 'from stderr' });
    });

    it('prefers stdout JSON over stderr JSON', async () => {
      const promise = runBridgeCommand('test-command');

      mockChild.stdout.emit('data', '{"result": "from stdout"}');
      mockChild.stderr.emit('data', '{"result": "from stderr"}');
      mockChild.emit('close', 0);

      const result = await promise;
      expect(result).toEqual({ result: 'from stdout' });
    });
  });

  describe('createVm', () => {
    it('calls bridge with create command', async () => {
      const promise = createVm('/configs/vm1.yaml');

      mockChild.stdout.emit('data', '{"success": true}');
      mockChild.emit('close', 0);

      await promise;

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['create', '/configs/vm1.yaml']),
        expect.any(Object),
      );
    });
  });

  describe('destroyVm', () => {
    it('calls bridge with destroy command', async () => {
      const promise = destroyVm('vm1');

      mockChild.stdout.emit('data', '{"success": true}');
      mockChild.emit('close', 0);

      await promise;

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['destroy', 'vm1']),
        expect.any(Object),
      );
    });
  });

  describe('startVm', () => {
    it('calls bridge with start command', async () => {
      const promise = startVm('vm1');

      mockChild.stdout.emit('data', '{"success": true}');
      mockChild.emit('close', 0);

      await promise;

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['start', 'vm1']),
        expect.any(Object),
      );
    });
  });

  describe('stopVm', () => {
    it('calls bridge with stop command', async () => {
      const promise = stopVm('vm1');

      mockChild.stdout.emit('data', '{"success": true}');
      mockChild.emit('close', 0);

      await promise;

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['stop', 'vm1']),
        expect.any(Object),
      );
    });
  });

  describe('cloneVm', () => {
    it('calls bridge with clone command', async () => {
      const promise = cloneVm('source-vm', '/configs/target.yaml');

      mockChild.stdout.emit('data', '{"success": true}');
      mockChild.emit('close', 0);

      await promise;

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['clone', 'source-vm', '/configs/target.yaml']),
        expect.any(Object),
      );
    });
  });

  describe('createVmSnapshot', () => {
    it('calls bridge with snapshot-create command', async () => {
      const promise = createVmSnapshot('vm1');

      mockChild.stdout.emit('data', '{"snapshot_id": "20260616_120000"}');
      mockChild.emit('close', 0);

      await promise;

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['snapshot-create', 'vm1']),
        expect.any(Object),
      );
    });
  });

  describe('restoreVmSnapshot', () => {
    it('calls bridge with snapshot-restore command', async () => {
      const promise = restoreVmSnapshot('vm1', '20260616_120000');

      mockChild.stdout.emit('data', '{"success": true}');
      mockChild.emit('close', 0);

      await promise;

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['snapshot-restore', 'vm1', '20260616_120000']),
        expect.any(Object),
      );
    });
  });

  describe('deleteVmSnapshot', () => {
    it('calls bridge with snapshot-delete command', async () => {
      const promise = deleteVmSnapshot('vm1', '20260616_120000');

      mockChild.stdout.emit('data', '{"success": true}');
      mockChild.emit('close', 0);

      await promise;

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['snapshot-delete', 'vm1', '20260616_120000']),
        expect.any(Object),
      );
    });
  });

  describe('inspectVm', () => {
    it('calls bridge with inspect command', async () => {
      const promise = inspectVm('vm1');

      mockChild.stdout.emit('data', '{"vm_name": "vm1", "state": "running"}');
      mockChild.emit('close', 0);

      await promise;

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['inspect', 'vm1']),
        expect.any(Object),
      );
    });
  });

  describe('reconcileVmNetworking', () => {
    it('calls bridge with reconcile command', async () => {
      const promise = reconcileVmNetworking();

      mockChild.stdout.emit('data', '{"success": true}');
      mockChild.emit('close', 0);

      await promise;

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['reconcile']),
        expect.any(Object),
      );
    });
  });

  describe('listVms', () => {
    it('calls bridge with list command', async () => {
      const promise = listVms();

      mockChild.stdout.emit('data', '{"vms": [{"name": "vm1"}]}');
      mockChild.emit('close', 0);

      await promise;

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['list']),
        expect.any(Object),
      );
    });
  });

  describe('listHostVmNames', () => {
    it('calls bridge with host-list command', async () => {
      const promise = listHostVmNames();

      mockChild.stdout.emit('data', '{"vms": ["vm1", "vm2"]}');
      mockChild.emit('close', 0);

      await promise;

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['host-list']),
        expect.any(Object),
      );
    });
  });

  describe('readVmLog', () => {
    it('reads VM log with sudo tail', async () => {
      const { readVmLog } = await import('../src/provisioner.js');
      
      // Mock for ensurePrivilegedLogPath (sudo test -f)
      const mockTestChild = {
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };

      // Mock for readVmLog (sudo tail)
      const mockTailChild = {
        stdout: { on: vi.fn((event, callback) => {
          if (event === 'data') callback('Log line 1\nLog line 2\n');
        }) },
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };

      spawn.mockImplementation((cmd, args) => {
        if (args.includes('test')) return mockTestChild;
        return mockTailChild;
      });

      const result = await readVmLog('test-vm', 50);

      expect(result).toContain('Log line 1');
      expect(result).toContain('Log line 2');
      expect(spawn).toHaveBeenCalledWith(
        'sudo',
        ['-n', 'tail', '-n', '50', expect.stringContaining('test-vm.log')],
        expect.any(Object),
      );
    });

    it('throws 404 when log file does not exist', async () => {
      const { readVmLog } = await import('../src/provisioner.js');

      const mockTestChild = {
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(1);
        }),
      };

      spawn.mockReturnValue(mockTestChild);

      await expect(readVmLog('nonexistent-vm')).rejects.toMatchObject({
        message: expect.stringContaining('not found'),
        statusCode: 404,
      });
    });

    it('throws 503 when sudo expires', async () => {
      const { readVmLog } = await import('../src/provisioner.js');

      const mockTestChild = {
        stderr: {
          on: vi.fn((event, callback) => {
            if (event === 'data') callback('sudo: a password is required');
          }),
        },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(1);
        }),
      };

      spawn.mockReturnValue(mockTestChild);

      await expect(readVmLog('test-vm')).rejects.toMatchObject({
        message: expect.stringContaining('expired'),
        statusCode: 503,
      });
    });
  });

  describe('streamVmLog', () => {
    it('streams VM log with SSE', async () => {
      const { streamVmLog } = await import('../src/provisioner.js');

      const mockTestChild = {
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };

      const mockTailChild = {
        stdout: {
          on: vi.fn((event, callback) => {
            if (event === 'data') {
              setTimeout(() => callback('Log line\n'), 10);
            }
          }),
        },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn(),
      };

      spawn.mockImplementation((cmd, args) => {
        if (args.includes('test')) return mockTestChild;
        return mockTailChild;
      });

      const mockResponse = {
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        write: vi.fn(),
        on: vi.fn(),
        end: vi.fn(),
      };

      await streamVmLog('test-vm', mockResponse, 50);

      expect(mockResponse.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(mockResponse.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
      expect(mockResponse.flushHeaders).toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledWith(
        'sudo',
        ['-n', 'tail', '-n', '50', '-F', expect.stringContaining('test-vm.log')],
        expect.any(Object),
      );
    });

    it('sends keep-alive messages', async () => {
      const { streamVmLog } = await import('../src/provisioner.js');

      vi.useFakeTimers();

      const mockTestChild = {
        stderr: { on: vi.fn() },
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
        }),
      };

      const mockTailChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn(),
      };

      spawn.mockImplementation((cmd, args) => {
        if (args.includes('test')) return mockTestChild;
        return mockTailChild;
      });

      const mockResponse = {
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        write: vi.fn(),
        on: vi.fn(),
        end: vi.fn(),
      };

      await streamVmLog('test-vm', mockResponse);

      vi.advanceTimersByTime(15000);

      expect(mockResponse.write).toHaveBeenCalledWith(': keep-alive\n\n');

      vi.useRealTimers();
    });
  });
});
