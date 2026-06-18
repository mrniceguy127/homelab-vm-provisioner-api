import { expect, test, vi } from 'vitest';

import { createJobService } from '../src/job-service.js';

function buildMockRepository() {
  return {
    enqueueJob: vi.fn(),
    getJob: vi.fn(),
    listJobs: vi.fn(),
    appendJobEvent: vi.fn(),
    listJobEvents: vi.fn(),
  };
}

test('enqueueVmProvisionJob enqueues a provision job with correct parameters', async () => {
  const mockRepo = buildMockRepository();
  const mockJob = {
    id: 123,
    type: 'provision_vm',
    status: 'queued',
    target_host_id: 'host-1',
    target_vm_id: 'test-vm',
    payload: { configPath: '/configs/test-vm.yaml' },
    created_at: new Date(),
  };
  
  mockRepo.enqueueJob.mockResolvedValue(mockJob);
  
  const service = createJobService({
    repository: mockRepo,
    hostId: 'host-1',
  });
  
  const result = await service.enqueueVmProvisionJob('test-vm', '/configs/test-vm.yaml');
  
  expect(mockRepo.enqueueJob).toHaveBeenCalledWith(
    'provision_vm',
    'host-1',
    { configPath: '/configs/test-vm.yaml' },
    { targetVmId: 'test-vm', maxAttempts: 3 }
  );
  
  expect(result).toEqual(mockJob);
});

test('enqueueVmDestroyJob enqueues a destroy job with correct parameters', async () => {
  const mockRepo = buildMockRepository();
  const mockJob = {
    id: 124,
    type: 'destroy_vm',
    status: 'queued',
    target_host_id: 'host-1',
    target_vm_id: 'test-vm',
    payload: { vmName: 'test-vm' },
    created_at: new Date(),
  };
  
  mockRepo.enqueueJob.mockResolvedValue(mockJob);
  
  const service = createJobService({
    repository: mockRepo,
    hostId: 'host-1',
  });
  
  const result = await service.enqueueVmDestroyJob('test-vm');
  
  expect(mockRepo.enqueueJob).toHaveBeenCalledWith(
    'destroy_vm',
    'host-1',
    { vmName: 'test-vm' },
    { targetVmId: 'test-vm', maxAttempts: 1 }
  );
  
  expect(result).toEqual(mockJob);
});

test('enqueueVmCloneJob enqueues a clone job with correct parameters', async () => {
  const mockRepo = buildMockRepository();
  const mockJob = {
    id: 125,
    type: 'clone_vm',
    status: 'queued',
    target_host_id: 'host-1',
    target_vm_id: 'new-vm',
    payload: { sourceVmName: 'source-vm', configPath: '/configs/new-vm.yaml' },
    created_at: new Date(),
  };
  
  mockRepo.enqueueJob.mockResolvedValue(mockJob);
  
  const service = createJobService({
    repository: mockRepo,
    hostId: 'host-1',
  });
  
  const result = await service.enqueueVmCloneJob('source-vm', 'new-vm', '/configs/new-vm.yaml');
  
  expect(mockRepo.enqueueJob).toHaveBeenCalledWith(
    'clone_vm',
    'host-1',
    { sourceVmName: 'source-vm', configPath: '/configs/new-vm.yaml' },
    { targetVmId: 'new-vm', maxAttempts: 3 }
  );
  
  expect(result).toEqual(mockJob);
});

test('enqueueVmReconcileJob enqueues a reconcile job with correct parameters', async () => {
  const mockRepo = buildMockRepository();
  const mockJob = {
    id: 126,
    type: 'reconcile_vm_networking',
    status: 'queued',
    target_host_id: 'host-1',
    target_vm_id: null,
    payload: { policyOnly: true },
    created_at: new Date(),
  };
  
  mockRepo.enqueueJob.mockResolvedValue(mockJob);
  
  const service = createJobService({
    repository: mockRepo,
    hostId: 'host-1',
  });
  
  const result = await service.enqueueVmReconcileJob({ policyOnly: true });
  
  expect(mockRepo.enqueueJob).toHaveBeenCalledWith(
    'reconcile_vm_networking',
    'host-1',
    { policyOnly: true },
    { targetVmId: null, maxAttempts: 1 }
  );
  
  expect(result).toEqual(mockJob);
});

test('enqueueVmProvisionJob throws error when hostId is not configured', async () => {
  const mockRepo = buildMockRepository();
  
  const service = createJobService({
    repository: mockRepo,
    hostId: null,
  });
  
  await expect(
    service.enqueueVmProvisionJob('test-vm', '/configs/test-vm.yaml')
  ).rejects.toThrow('HOST_ID is not configured');
});

test('getJobById retrieves a job by ID', async () => {
  const mockRepo = buildMockRepository();
  const mockJob = {
    id: 123,
    type: 'provision_vm',
    status: 'running',
    target_host_id: 'host-1',
    target_vm_id: 'test-vm',
    payload: { configPath: '/configs/test-vm.yaml' },
    created_at: new Date(),
  };
  
  mockRepo.getJob.mockResolvedValue(mockJob);
  
  const service = createJobService({
    repository: mockRepo,
    hostId: 'host-1',
  });
  
  const result = await service.getJobById(123);
  
  expect(mockRepo.getJob).toHaveBeenCalledWith(123);
  expect(result).toEqual(mockJob);
});

test('getJobEvents retrieves events for a job', async () => {
  const mockRepo = buildMockRepository();
  const mockEvents = [
    {
      id: 1,
      job_id: 123,
      level: 'info',
      message: 'Job started',
      created_at: new Date(),
    },
    {
      id: 2,
      job_id: 123,
      level: 'info',
      message: 'Job completed',
      created_at: new Date(),
    },
  ];
  
  mockRepo.listJobEvents.mockResolvedValue(mockEvents);
  
  const service = createJobService({
    repository: mockRepo,
    hostId: 'host-1',
  });
  
  const result = await service.getJobEvents(123);
  
  expect(mockRepo.listJobEvents).toHaveBeenCalledWith(123, 100);
  expect(result).toEqual(mockEvents);
});

test('getJobEvents accepts custom limit', async () => {
  const mockRepo = buildMockRepository();
  mockRepo.listJobEvents.mockResolvedValue([]);
  
  const service = createJobService({
    repository: mockRepo,
    hostId: 'host-1',
  });
  
  await service.getJobEvents(123, 50);
  
  expect(mockRepo.listJobEvents).toHaveBeenCalledWith(123, 50);
});
