import { expect, test, vi } from 'vitest';

import { createJobService } from '../src/job-service.js';

function buildMockRepository() {
  return {
    enqueueJob: vi.fn(),
    getJob: vi.fn(),
    listJobs: vi.fn(),
    appendJobEvent: vi.fn(),
    listJobEvents: vi.fn(),
    updateJobStatus: vi.fn(),
  };
}

function buildMockRabbitMqPublisher() {
  return {
    publishJob: vi.fn().mockResolvedValue(true),
    close: vi.fn(),
  };
}

test('enqueueVmProvisionJob enqueues a provision job with correct parameters', async () => {
  const mockRepo = buildMockRepository();
  const mockRabbitMq = buildMockRabbitMqPublisher();
  const mockJob = {
    id: 123,
    type: 'provision_vm',
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
    rabbitMqPublisher: mockRabbitMq,
  });
  
  const result = await service.enqueueVmProvisionJob('test-vm');
  
  expect(mockRepo.enqueueJob).toHaveBeenCalledWith(
    'provision_vm',
    'host-1',
    { vmName: 'test-vm' },
    { targetVmId: 'test-vm', maxAttempts: 3 }
  );
  
  expect(mockRabbitMq.publishJob).toHaveBeenCalledWith({
    job_id: 123,
    job_type: 'provision_vm',
    target_host_id: 'host-1',
  });
  
  expect(mockRepo.updateJobStatus).toHaveBeenCalledWith(123, 'published', expect.any(Object));
  expect(result).toEqual(mockJob);
});

test('enqueueVmDestroyJob enqueues a destroy job with correct parameters', async () => {
  const mockRepo = buildMockRepository();
  const mockRabbitMq = buildMockRabbitMqPublisher();
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
    rabbitMqPublisher: mockRabbitMq,
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
  const mockRabbitMq = buildMockRabbitMqPublisher();
  const mockJob = {
    id: 125,
    type: 'clone_vm',
    status: 'queued',
    target_host_id: 'host-1',
    target_vm_id: 'new-vm',
    payload: { sourceVmName: 'source-vm', targetVmName: 'new-vm' },
    created_at: new Date(),
  };
  
  mockRepo.enqueueJob.mockResolvedValue(mockJob);
  
  const service = createJobService({
    repository: mockRepo,
    hostId: 'host-1',
    rabbitMqPublisher: mockRabbitMq,
  });
  
  const result = await service.enqueueVmCloneJob('source-vm', 'new-vm');
  
  expect(mockRepo.enqueueJob).toHaveBeenCalledWith(
    'clone_vm',
    'host-1',
    { sourceVmName: 'source-vm', targetVmName: 'new-vm' },
    { targetVmId: 'new-vm', maxAttempts: 3 }
  );
  
  expect(result).toEqual(mockJob);
});

test('enqueueVmReconcileJob enqueues a reconcile job with correct parameters', async () => {
  const mockRepo = buildMockRepository();
  const mockRabbitMq = buildMockRabbitMqPublisher();
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
    rabbitMqPublisher: mockRabbitMq,
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
    service.enqueueVmProvisionJob('test-vm')
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
    payload: { vmName: 'test-vm' },
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

test('enqueueVmProvisionJob throws error when RabbitMQ is not configured', async () => {
  const mockRepo = buildMockRepository();
  const mockJob = {
    id: 123,
    type: 'provision_vm',
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
    rabbitMqPublisher: null,
  });
  
  await expect(
    service.enqueueVmProvisionJob('test-vm')
  ).rejects.toThrow('RabbitMQ is not configured');
});

test('enqueueVmProvisionJob marks job as publish_failed when RabbitMQ publish fails', async () => {
  const mockRepo = buildMockRepository();
  const mockRabbitMq = buildMockRabbitMqPublisher();
  const mockJob = {
    id: 123,
    type: 'provision_vm',
    status: 'queued',
    target_host_id: 'host-1',
    target_vm_id: 'test-vm',
    payload: { vmName: 'test-vm' },
    created_at: new Date(),
  };
  
  mockRepo.enqueueJob.mockResolvedValue(mockJob);
  mockRabbitMq.publishJob.mockRejectedValue(new Error('Connection failed'));
  
  const service = createJobService({
    repository: mockRepo,
    hostId: 'host-1',
    rabbitMqPublisher: mockRabbitMq,
  });
  
  await expect(
    service.enqueueVmProvisionJob('test-vm')
  ).rejects.toThrow('Failed to publish job to queue');
  
  expect(mockRepo.updateJobStatus).toHaveBeenCalledWith(123, 'publish_failed', {
    error: 'RabbitMQ publish failed: Connection failed',
  });
});

test('enqueueVmStartJob enqueues a start job with correct parameters', async () => {
  const mockRepo = buildMockRepository();
  const mockRabbitMq = buildMockRabbitMqPublisher();
  const mockJob = {
    id: 126,
    type: 'start_vm',
    status: 'queued',
    target_host_id: 'host-1',
    target_vm_id: 'test-vm',
    payload: { vmName: 'test-vm' },
  };
  
  mockRepo.enqueueJob.mockResolvedValue(mockJob);
  
  const service = createJobService({
    repository: mockRepo,
    hostId: 'host-1',
    rabbitMqPublisher: mockRabbitMq,
  });
  
  const result = await service.enqueueVmStartJob('test-vm');
  
  expect(mockRepo.enqueueJob).toHaveBeenCalledWith(
    'start_vm',
    'host-1',
    { vmName: 'test-vm' },
    { targetVmId: 'test-vm', maxAttempts: 1 }
  );
  
  expect(result).toEqual(mockJob);
});

test('enqueueVmStopJob enqueues a stop job with correct parameters', async () => {
  const mockRepo = buildMockRepository();
  const mockRabbitMq = buildMockRabbitMqPublisher();
  const mockJob = {
    id: 127,
    type: 'stop_vm',
    status: 'queued',
    target_host_id: 'host-1',
    target_vm_id: 'test-vm',
    payload: { vmName: 'test-vm' },
  };
  
  mockRepo.enqueueJob.mockResolvedValue(mockJob);
  
  const service = createJobService({
    repository: mockRepo,
    hostId: 'host-1',
    rabbitMqPublisher: mockRabbitMq,
  });
  
  const result = await service.enqueueVmStopJob('test-vm');
  
  expect(mockRepo.enqueueJob).toHaveBeenCalledWith(
    'stop_vm',
    'host-1',
    { vmName: 'test-vm' },
    { targetVmId: 'test-vm', maxAttempts: 1 }
  );
  
  expect(result).toEqual(mockJob);
});

test('enqueueVmSnapshotCreateJob enqueues a snapshot create job', async () => {
  const mockRepo = buildMockRepository();
  const mockRabbitMq = buildMockRabbitMqPublisher();
  const mockJob = {
    id: 128,
    type: 'snapshot_create',
    status: 'queued',
    target_host_id: 'host-1',
    target_vm_id: 'test-vm',
    payload: { vmName: 'test-vm' },
  };
  
  mockRepo.enqueueJob.mockResolvedValue(mockJob);
  
  const service = createJobService({
    repository: mockRepo,
    hostId: 'host-1',
    rabbitMqPublisher: mockRabbitMq,
  });
  
  const result = await service.enqueueVmSnapshotCreateJob('test-vm');
  
  expect(mockRepo.enqueueJob).toHaveBeenCalledWith(
    'snapshot_create',
    'host-1',
    { vmName: 'test-vm' },
    { targetVmId: 'test-vm', maxAttempts: 1 }
  );
  
  expect(result).toEqual(mockJob);
});

test('enqueueVmSnapshotRestoreJob enqueues a snapshot restore job', async () => {
  const mockRepo = buildMockRepository();
  const mockRabbitMq = buildMockRabbitMqPublisher();
  const mockJob = {
    id: 129,
    type: 'snapshot_restore',
    status: 'queued',
    target_host_id: 'host-1',
    target_vm_id: 'test-vm',
    payload: { vmName: 'test-vm', snapshotId: 'snap-123' },
  };
  
  mockRepo.enqueueJob.mockResolvedValue(mockJob);
  
  const service = createJobService({
    repository: mockRepo,
    hostId: 'host-1',
    rabbitMqPublisher: mockRabbitMq,
  });
  
  const result = await service.enqueueVmSnapshotRestoreJob('test-vm', 'snap-123');
  
  expect(mockRepo.enqueueJob).toHaveBeenCalledWith(
    'snapshot_restore',
    'host-1',
    { vmName: 'test-vm', snapshotId: 'snap-123' },
    { targetVmId: 'test-vm', maxAttempts: 1 }
  );
  
  expect(result).toEqual(mockJob);
});

test('enqueueVmSnapshotDeleteJob enqueues a snapshot delete job', async () => {
  const mockRepo = buildMockRepository();
  const mockRabbitMq = buildMockRabbitMqPublisher();
  const mockJob = {
    id: 130,
    type: 'snapshot_delete',
    status: 'queued',
    target_host_id: 'host-1',
    target_vm_id: 'test-vm',
    payload: { vmName: 'test-vm', snapshotId: 'snap-123' },
  };
  
  mockRepo.enqueueJob.mockResolvedValue(mockJob);
  
  const service = createJobService({
    repository: mockRepo,
    hostId: 'host-1',
    rabbitMqPublisher: mockRabbitMq,
  });
  
  const result = await service.enqueueVmSnapshotDeleteJob('test-vm', 'snap-123');
  
  expect(mockRepo.enqueueJob).toHaveBeenCalledWith(
    'snapshot_delete',
    'host-1',
    { vmName: 'test-vm', snapshotId: 'snap-123' },
    { targetVmId: 'test-vm', maxAttempts: 1 }
  );
  
  expect(result).toEqual(mockJob);
});
