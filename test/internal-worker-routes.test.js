/**
 * Tests for internal worker API routes
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createInternalWorkerRouter } from '../src/internal-worker-routes.js';

// Helper to create isolated test setup
function createTestSetup() {
  const mockRepository = {
    getJob: vi.fn(),
    updateJobStatus: vi.fn(),
    appendJobEvent: vi.fn()
  };
  
  const app = express();
  app.use(express.json());
  const router = createInternalWorkerRouter({
    repository: mockRepository,
    hostId: 'local'
  });
  app.use('/internal/worker', router);
  
  return { app, mockRepository };
}

describe('Internal Worker Routes', () => {
  describe('GET /internal/worker/jobs/:jobId', () => {
    it('should return job details', async () => {
      const { app, mockRepository } = createTestSetup();
      
      const mockJob = {
        id: 1,
        type: 'provision_vm',
        status: 'queued',
        target_host_id: 'local',
        payload: { vmName: 'test-vm' }
      };
      
      mockRepository.getJob.mockResolvedValue(mockJob);
      
      const response = await request(app)
        .get('/internal/worker/jobs/1');
      
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject(mockJob);
      expect(mockRepository.getJob).toHaveBeenCalledWith(1);
    });
    
    it('should return 404 if job not found', async () => {
      const { app, mockRepository } = createTestSetup();
      
      mockRepository.getJob.mockResolvedValue(null);
      
      const response = await request(app)
        .get('/internal/worker/jobs/999');
      
      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
    });
    
    it('should return 400 for invalid job ID', async () => {
      const { app } = createTestSetup();
      
      const response = await request(app)
        .get('/internal/worker/jobs/invalid');
      
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });
  });
  
  describe('POST /internal/worker/jobs/:jobId/start', () => {
    it('should mark job as running', async () => {
      const { app, mockRepository } = createTestSetup();
      
      const mockJob = {
        id: 1,
        type: 'provision_vm',
        status: 'queued',
        target_host_id: 'local'
      };
      
      mockRepository.getJob.mockResolvedValue(mockJob);
      mockRepository.updateJobStatus.mockResolvedValue({ ...mockJob, status: 'running' });
      mockRepository.appendJobEvent.mockResolvedValue({});
      
      const response = await request(app)
        .post('/internal/worker/jobs/1/start')
        .send({ worker_id: 'worker-1' });
      
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockRepository.updateJobStatus).toHaveBeenCalledWith(
        1,
        'running',
        expect.objectContaining({
          claimed_by: 'worker-1',
          started_at: expect.any(Date)
        })
      );
    });
    
    it('should reject if job not in queued or published status', async () => {
      const { app, mockRepository } = createTestSetup();
      
      const mockJob = {
        id: 1,
        type: 'provision_vm',
        status: 'running',
        target_host_id: 'local'
      };
      
      mockRepository.getJob.mockResolvedValue(mockJob);
      
      const response = await request(app)
        .post('/internal/worker/jobs/1/start')
        .send({ worker_id: 'worker-1' });
      
      expect(response.status).toBe(409);
      expect(response.body.error).toContain('Cannot start job in status running');
    });
    
    it('should reject if worker host ID does not match', async () => {
      const { app, mockRepository } = createTestSetup();
      
      const mockJob = {
        id: 1,
        type: 'provision_vm',
        status: 'queued',
        target_host_id: 'remote'
      };
      
      mockRepository.getJob.mockResolvedValue(mockJob);
      
      const response = await request(app)
        .post('/internal/worker/jobs/1/start')
        .send({ worker_id: 'worker-1', worker_host_id: 'local' });
      
      expect(response.status).toBe(403);
      expect(response.body.error).toContain('Worker host ID does not match');
    });
  });
  
  describe('POST /internal/worker/jobs/:jobId/heartbeat', () => {
    it('should update heartbeat timestamp', async () => {
      const { app, mockRepository } = createTestSetup();
      
      const mockJob = {
        id: 1,
        type: 'provision_vm',
        status: 'running',
        target_host_id: 'local'
      };
      
      mockRepository.getJob.mockResolvedValue(mockJob);
      mockRepository.updateJobStatus.mockResolvedValue(mockJob);
      
      const response = await request(app)
        .post('/internal/worker/jobs/1/heartbeat')
        .send({});
      
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockRepository.updateJobStatus).toHaveBeenCalledWith(
        1,
        'running',
        expect.objectContaining({
          last_heartbeat_at: expect.any(Date)
        })
      );
    });
  });
  
  describe('POST /internal/worker/jobs/:jobId/succeed', () => {
    it('should mark job as succeeded', async () => {
      const { app, mockRepository } = createTestSetup();
      
      const mockJob = {
        id: 1,
        type: 'provision_vm',
        status: 'running',
        target_host_id: 'local'
      };
      
      const result = { vm_id: 'test-vm', ip_address: '10.0.0.5' };
      
      mockRepository.getJob.mockResolvedValue(mockJob);
      mockRepository.updateJobStatus.mockResolvedValue({ ...mockJob, status: 'succeeded' });
      mockRepository.appendJobEvent.mockResolvedValue({});
      
      const response = await request(app)
        .post('/internal/worker/jobs/1/succeed')
        .send({ result });
      
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockRepository.updateJobStatus).toHaveBeenCalledWith(
        1,
        'succeeded',
        expect.objectContaining({
          result,
          finished_at: expect.any(Date)
        })
      );
    });
    
    it('should reject if job not in running status', async () => {
      const { app, mockRepository } = createTestSetup();
      
      const mockJob = {
        id: 1,
        type: 'provision_vm',
        status: 'queued',
        target_host_id: 'local'
      };
      
      mockRepository.getJob.mockResolvedValue(mockJob);
      
      const response = await request(app)
        .post('/internal/worker/jobs/1/succeed')
        .send({ result: {} });
      
      expect(response.status).toBe(409);
      expect(response.body.error).toContain('Cannot succeed job in status queued');
    });
  });
  
  describe('POST /internal/worker/jobs/:jobId/fail', () => {
    it('should mark job as failed', async () => {
      const { app, mockRepository } = createTestSetup();
      
      const mockJob = {
        id: 1,
        type: 'provision_vm',
        status: 'running',
        target_host_id: 'local',
        attempts: 0
      };
      
      mockRepository.getJob.mockResolvedValue(mockJob);
      mockRepository.updateJobStatus.mockResolvedValue({ ...mockJob, status: 'failed' });
      mockRepository.appendJobEvent.mockResolvedValue({});
      
      const response = await request(app)
        .post('/internal/worker/jobs/1/fail')
        .send({ error: 'VM creation failed', retryable: false });
      
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockRepository.updateJobStatus).toHaveBeenCalledWith(
        1,
        'failed',
        expect.objectContaining({
          error: 'VM creation failed',
          finished_at: expect.any(Date),
          attempts: 1
        })
      );
    });
    
    it('should use retryable_failed status if retryable is true', async () => {
      const { app, mockRepository } = createTestSetup();
      
      const mockJob = {
        id: 1,
        type: 'provision_vm',
        status: 'running',
        target_host_id: 'local',
        attempts: 0
      };
      
      mockRepository.getJob.mockResolvedValue(mockJob);
      mockRepository.updateJobStatus.mockResolvedValue({ ...mockJob, status: 'retryable_failed' });
      mockRepository.appendJobEvent.mockResolvedValue({});
      
      const response = await request(app)
        .post('/internal/worker/jobs/1/fail')
        .send({ error: 'Temporary failure', retryable: true });
      
      expect(response.status).toBe(200);
      expect(mockRepository.updateJobStatus).toHaveBeenCalledWith(
        1,
        'retryable_failed',
        expect.any(Object)
      );
    });
  });
  
  describe('POST /internal/worker/jobs/:jobId/cleanup-required', () => {
    it('should mark job as cleanup_required', async () => {
      const { app, mockRepository } = createTestSetup();
      
      const mockJob = {
        id: 1,
        type: 'provision_vm',
        status: 'running',
        target_host_id: 'local'
      };
      
      const cleanupContext = {
        vm_id: 'partial-vm',
        resources: ['disk', 'network']
      };
      
      mockRepository.getJob.mockResolvedValue(mockJob);
      mockRepository.updateJobStatus.mockResolvedValue({ ...mockJob, status: 'cleanup_required' });
      mockRepository.appendJobEvent.mockResolvedValue({});
      
      const response = await request(app)
        .post('/internal/worker/jobs/1/cleanup-required')
        .send({ cleanup_context: cleanupContext });
      
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockRepository.updateJobStatus).toHaveBeenCalledWith(
        1,
        'cleanup_required',
        expect.objectContaining({
          cleanup_context: cleanupContext,
          finished_at: expect.any(Date)
        })
      );
    });
  });
});
