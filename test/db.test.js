import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  initializeDatabase,
  getRepository,
  isDatabaseAvailable,
  closeDatabase,
} from '../src/db.js';

describe('database client', () => {
  let mockFetch;
  const testUrl = 'http://172.17.0.1:3002'; // Use default URL since it's cached at module load
  
  beforeEach(async () => {
    // Reset global repository
    await closeDatabase();
    
    // Mock fetch
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  describe('initializeDatabase', () => {
    it('initializes successfully with valid health check', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, service: 'test-db' }),
      });

      await initializeDatabase();

      expect(mockFetch).toHaveBeenCalledWith(`${testUrl}/health`);
      expect(isDatabaseAvailable()).toBe(true);
      expect(getRepository()).not.toBeNull();
    });

    it('throws error when health check fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Service unavailable' }),
      });

      await expect(initializeDatabase()).rejects.toThrow(
        'Health check failed with status'
      );
      expect(isDatabaseAvailable()).toBe(false);
    });

    it('throws error when health check returns not ok', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false }),
      });

      await expect(initializeDatabase()).rejects.toThrow(
        'Database microservice health check returned not ok'
      );
    });

    it('warns and returns if already initialized', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      });

      await initializeDatabase();
      await initializeDatabase();

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('accepts custom service URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      });

      await initializeDatabase('http://custom:4000');

      expect(mockFetch).toHaveBeenCalledWith('http://custom:4000/health');
    });
  });

  describe('JobRepositoryClient', () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      });
      await initializeDatabase();
    });

    describe('enqueueJob', () => {
      it('creates a job successfully', async () => {
        const mockJob = { id: 1, status: 'queued' };
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ job: mockJob }),
        });

        const repository = getRepository();
        const result = await repository.enqueueJob(
          'provision_vm',
          'host1',
          { vmName: 'test' },
          { targetVmId: 'vm1', maxAttempts: 3 }
        );

        expect(result).toEqual(mockJob);
        expect(mockFetch).toHaveBeenCalledWith(
          `${testUrl}/jobs`,
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
              'Authorization': expect.stringContaining('Bearer'),
            }),
          })
        );
      });

      it('throws error on failure', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          json: async () => ({ error: 'Invalid request' }),
        });

        const repository = getRepository();
        await expect(
          repository.enqueueJob('provision_vm', 'host1', {})
        ).rejects.toThrow('Invalid request');
      });
    });

    describe('getJob', () => {
      it('retrieves a job by ID', async () => {
        const mockJob = { id: 1, status: 'running' };
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ job: mockJob }),
        });

        const repository = getRepository();
        const result = await repository.getJob(1);

        expect(result).toEqual(mockJob);
        expect(mockFetch).toHaveBeenCalledWith(
          `${testUrl}/jobs/1`,
          expect.any(Object)
        );
      });
    });

    describe('listJobs', () => {
      it('lists all jobs without filters', async () => {
        const mockJobs = [{ id: 1 }, { id: 2 }];
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ jobs: mockJobs }),
        });

        const repository = getRepository();
        const result = await repository.listJobs();

        expect(result).toEqual(mockJobs);
        expect(mockFetch).toHaveBeenCalledWith(
          `${testUrl}/jobs`,
          expect.any(Object)
        );
      });

      it('lists jobs with filters', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ jobs: [] }),
        });

        const repository = getRepository();
        await repository.listJobs({
          status: 'queued',
          targetHostId: 'host1',
          limit: 10,
        });

        expect(mockFetch).toHaveBeenCalledWith(
          `${testUrl}/jobs?status=queued&targetHostId=host1&limit=10`,
          expect.any(Object)
        );
      });
    });

    describe('appendJobEvent', () => {
      it('appends an event to a job', async () => {
        const mockEvent = { id: 1, level: 'info', message: 'Started' };
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ event: mockEvent }),
        });

        const repository = getRepository();
        const result = await repository.appendJobEvent(1, 'info', 'Started', { foo: 'bar' });

        expect(result).toEqual(mockEvent);
        expect(mockFetch).toHaveBeenCalledWith(
          `${testUrl}/jobs/1/events`,
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
              level: 'info',
              message: 'Started',
              metadata: { foo: 'bar' },
            }),
          })
        );
      });

      it('appends event without metadata', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ event: {} }),
        });

        const repository = getRepository();
        await repository.appendJobEvent(1, 'info', 'Started');

        const call = mockFetch.mock.calls[1][1];
        const body = JSON.parse(call.body);
        expect(body.metadata).toBeNull();
      });
    });

    describe('listJobEvents', () => {
      it('lists job events with default limit', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ events: [] }),
        });

        const repository = getRepository();
        await repository.listJobEvents(1);

        expect(mockFetch).toHaveBeenCalledWith(
          `${testUrl}/jobs/1/events?limit=100`,
          expect.any(Object)
        );
      });

      it('lists job events with custom limit', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ events: [] }),
        });

        const repository = getRepository();
        await repository.listJobEvents(1, 50);

        expect(mockFetch).toHaveBeenCalledWith(
          `${testUrl}/jobs/1/events?limit=50`,
          expect.any(Object)
        );
      });
    });

    describe('claimNextJobForHost', () => {
      it('claims a job successfully', async () => {
        const mockJob = { id: 1, status: 'claimed' };
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ job: mockJob }),
        });

        const repository = getRepository();
        const result = await repository.claimNextJobForHost('host1', 'worker1');

        expect(result).toEqual(mockJob);
      });

      it('returns null when no jobs available (404)', async () => {
        const error = new Error('No jobs available');
        error.statusCode = 404;
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 404,
          json: async () => ({ error: 'No jobs available' }),
        });

        const repository = getRepository();
        const result = await repository.claimNextJobForHost('host1', 'worker1');

        expect(result).toBeNull();
      });

      it('throws error for non-404 failures', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: async () => ({ error: 'Server error' }),
        });

        const repository = getRepository();
        await expect(
          repository.claimNextJobForHost('host1', 'worker1')
        ).rejects.toThrow('Server error');
      });
    });

    describe('markJobRunning', () => {
      it('marks job as running', async () => {
        const mockJob = { id: 1, status: 'running' };
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ job: mockJob }),
        });

        const repository = getRepository();
        const result = await repository.markJobRunning(1, 'worker1');

        expect(result).toEqual(mockJob);
        expect(mockFetch).toHaveBeenCalledWith(
          `${testUrl}/jobs/1/running`,
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ workerId: 'worker1' }),
          })
        );
      });
    });

    describe('markJobSucceeded', () => {
      it('marks job as succeeded with result', async () => {
        const mockJob = { id: 1, status: 'succeeded' };
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ job: mockJob }),
        });

        const repository = getRepository();
        const result = await repository.markJobSucceeded(1, { output: 'done' });

        expect(result).toEqual(mockJob);
        expect(mockFetch).toHaveBeenCalledWith(
          `${testUrl}/jobs/1/succeeded`,
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ result: { output: 'done' } }),
          })
        );
      });

      it('marks job as succeeded with default empty result', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ job: {} }),
        });

        const repository = getRepository();
        await repository.markJobSucceeded(1);

        const call = mockFetch.mock.calls[1][1];
        const body = JSON.parse(call.body);
        expect(body.result).toEqual({});
      });
    });

    describe('markJobFailed', () => {
      it('marks job as failed', async () => {
        const mockJob = { id: 1, status: 'failed' };
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ job: mockJob }),
        });

        const repository = getRepository();
        const result = await repository.markJobFailed(1, 'Network error', true);

        expect(result).toEqual(mockJob);
        expect(mockFetch).toHaveBeenCalledWith(
          `${testUrl}/jobs/1/failed`,
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
              error: 'Network error',
              retriable: true,
            }),
          })
        );
      });

      it('uses default retriable false', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ job: {} }),
        });

        const repository = getRepository();
        await repository.markJobFailed(1, 'Error');

        const call = mockFetch.mock.calls[1][1];
        const body = JSON.parse(call.body);
        expect(body.retriable).toBe(false);
      });
    });

    describe('cancelQueuedJob', () => {
      it('cancels a queued job', async () => {
        const mockJob = { id: 1, status: 'cancelled' };
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ job: mockJob }),
        });

        const repository = getRepository();
        const result = await repository.cancelQueuedJob(1);

        expect(result).toEqual(mockJob);
        expect(mockFetch).toHaveBeenCalledWith(
          `${testUrl}/jobs/1/cancel`,
          expect.objectContaining({
            method: 'POST',
          })
        );
      });
    });

    describe('acquireResourceLocks', () => {
      it('acquires locks with default TTL', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ acquired: true }),
        });

        const repository = getRepository();
        const result = await repository.acquireResourceLocks(
          1,
          'worker1',
          ['vm1', 'vm2']
        );

        expect(result).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
          `${testUrl}/locks/acquire`,
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
              jobId: 1,
              workerId: 'worker1',
              lockKeys: ['vm1', 'vm2'],
              ttlMs: 300000,
            }),
          })
        );
      });

      it('acquires locks with custom TTL', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ acquired: true }),
        });

        const repository = getRepository();
        await repository.acquireResourceLocks(1, 'worker1', ['vm1'], 60000);

        const call = mockFetch.mock.calls[1][1];
        const body = JSON.parse(call.body);
        expect(body.ttlMs).toBe(60000);
      });
    });

    describe('releaseResourceLocks', () => {
      it('releases locks with worker ID', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ released: 2 }),
        });

        const repository = getRepository();
        const result = await repository.releaseResourceLocks(1, 'worker1');

        expect(result).toBe(2);
        expect(mockFetch).toHaveBeenCalledWith(
          `${testUrl}/locks/release`,
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
              jobId: 1,
              workerId: 'worker1',
            }),
          })
        );
      });

      it('releases locks without worker ID', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ released: 2 }),
        });

        const repository = getRepository();
        await repository.releaseResourceLocks(1);

        const call = mockFetch.mock.calls[1][1];
        const body = JSON.parse(call.body);
        expect(body.workerId).toBeNull();
      });
    });

    describe('cleanupExpiredLocks', () => {
      it('cleans up expired locks', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ cleaned: 5 }),
        });

        const repository = getRepository();
        const result = await repository.cleanupExpiredLocks();

        expect(result).toBe(5);
        expect(mockFetch).toHaveBeenCalledWith(
          `${testUrl}/locks/cleanup`,
          expect.objectContaining({
            method: 'POST',
          })
        );
      });
    });
  });

  describe('helper functions', () => {
    it('isDatabaseAvailable returns false initially', () => {
      expect(isDatabaseAvailable()).toBe(false);
    });

    it('getRepository returns null initially', () => {
      expect(getRepository()).toBeNull();
    });

    it('closeDatabase resets repository', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      });

      await initializeDatabase();
      expect(isDatabaseAvailable()).toBe(true);

      await closeDatabase();
      expect(isDatabaseAvailable()).toBe(false);
      expect(getRepository()).toBeNull();
    });
  });
});
