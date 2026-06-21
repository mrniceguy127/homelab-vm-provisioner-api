import { expect, test, vi } from 'vitest';

import request from 'supertest';

import { createApp } from '../src/app.js';
import {
  formatValidationError,
  isValidationError,
  parseCreateVmRequest,
  parseNetworkGroupRequest,
  parseVmPolicyRequest,
} from '../src/validation.js';

function buildMockRepository() {
  return {
    enqueueJob: vi.fn(),
    getJob: vi.fn(),
    listJobs: vi.fn(),
    appendJobEvent: vi.fn(),
    listJobEvents: vi.fn(),
  };
}

function buildMockJobService() {
  return {
    enqueueVmProvisionJob: vi.fn(async (vmName) => ({
      id: 123,
      type: 'provision_vm',
      status: 'queued',
      target_host_id: 'test-host',
      target_vm_id: vmName,
      payload: { vmName },
      created_at: new Date(),
    })),
    enqueueVmDestroyJob: vi.fn(async (vmName) => ({
      id: 124,
      type: 'destroy_vm',
      status: 'queued',
      target_host_id: 'test-host',
      target_vm_id: vmName,
      payload: { vmName },
      created_at: new Date(),
    })),
    enqueueVmCloneJob: vi.fn(async (sourceVmName, targetVmName) => ({
      id: 125,
      type: 'clone_vm',
      status: 'queued',
      target_host_id: 'test-host',
      target_vm_id: targetVmName,
      payload: { sourceVmName, targetVmName },
      created_at: new Date(),
    })),
    enqueueVmReconcileJob: vi.fn(async (options) => ({
      id: 126,
      type: 'reconcile_vm_networking',
      status: 'queued',
      target_host_id: 'test-host',
      target_vm_id: null,
      payload: options,
      created_at: new Date(),
    })),
    enqueueVmStartJob: vi.fn(async (vmName) => ({ id: 127, type: 'start_vm', status: 'queued', target_vm_id: vmName, payload: { vmName }, created_at: new Date() })),
    enqueueVmStopJob: vi.fn(async (vmName) => ({ id: 128, type: 'stop_vm', status: 'queued', target_vm_id: vmName, payload: { vmName }, created_at: new Date() })),
    enqueueVmSnapshotCreateJob: vi.fn(async (vmName) => ({ id: 129, type: 'snapshot_create', status: 'queued', target_vm_id: vmName, payload: { vmName }, created_at: new Date() })),
    enqueueVmSnapshotRestoreJob: vi.fn(async (vmName, snapshotId) => ({ id: 130, type: 'snapshot_restore', status: 'queued', target_vm_id: vmName, payload: { vmName, snapshotId }, created_at: new Date() })),
    enqueueVmSnapshotDeleteJob: vi.fn(async (vmName, snapshotId) => ({ id: 131, type: 'snapshot_delete', status: 'queued', target_vm_id: vmName, payload: { vmName, snapshotId }, created_at: new Date() })),
    getJobById: vi.fn(),
    getJobEvents: vi.fn(),
  };
}

function buildDeps(overrides = {}) {
  const mockRepository = buildMockRepository();
  const mockJobService = buildMockJobService();
  
  return {
    configPathForVm: (vmName) => `/configs/${vmName}.yaml`,
    deleteSavedConfigArtifacts: async () => {},
    createNetworkGroup: async ({ ownerUserId, name, profile = 'isolated_nat' }) => ({
      id: 'ng-test',
      owner_user_id: ownerUserId,
      name,
      profile,
    }),
    listStoredConfigNames: async () => [],
    listNetworkGroups: async () => [],
    listUsers: async () => [{ id: 'user-admin', username: 'admin', role: 'admin' }],
    loadStoredConfig: async (vmName) => ({
      vmName,
      configPath: `/configs/${vmName}.yaml`,
      config: {
        vm: {
          name: vmName,
          user: 'matt',
          owner_user_id: 'user-admin',
          network_group_id: 'ng-test',
          ram_mb: 4096,
          vcpus: 2,
          disk_gb: 40,
        },
        network: {
          network_group_id: 'ng-test',
          profile: 'isolated_nat',
          subnet_cidr: '10.80.0.0/28',
          vm_ip: '10.80.0.2',
          mac: '52:54:00:11:22:33',
        },
      },
    }),
    prepareVmConfigForSave: async ({ config, sshPublicKey, setupScript }) => ({
      config: {
        ...config,
        vm: {
          ...config.vm,
          owner_user_id: config.vm.owner_user_id || 'user-admin',
          network_group_id: config.vm.network_group_id || 'ng-test',
          ip_address: config.vm.ip_address || '10.80.0.2',
          mac_address: config.vm.mac_address || '52:54:00:11:22:33',
        },
        network: {
          ...(config.network || {}),
          network_group_id: config.vm.network_group_id || 'ng-test',
          profile: 'isolated_nat',
          subnet_cidr: '10.80.0.0/28',
          vm_ip: config.vm.ip_address || '10.80.0.2',
          mac: config.vm.mac_address || '52:54:00:11:22:33',
        },
      },
      sshPublicKey,
      setupScript,
    }),
    saveVmConfig: async ({ config }) => ({
      vmName: config.vm.name,
      vmDefinitionId: 42,
      configPath: null,
      rawConfig: 'vm: {}',
      config,
    }),
    upsertStoredVmDefinitionAndEnqueueJob: vi.fn(async (vmDefinition, jobType, _jobPayload, _jobOptions) => ({
      vmDefinition: { id: 42, ...vmDefinition },
      job: {
        id: {
          provision_vm: 123,
          clone_vm: 125,
          reconcile_vm_networking: 126,
        }[jobType] || 123,
        status: 'queued',
      },
    })),
    cloneVm: async (sourceVmName, configPath) => ({ success: true, source_name: sourceVmName, config_path: configPath }),
    createVm: async (configPath) => ({ success: true, config_path: configPath }),
    createVmSnapshot: async (vmName) => ({ success: true, name: vmName }),
    deleteVmSnapshot: async (vmName, snapshotId) => ({ success: true, name: vmName, snapshotId }),
    destroyVm: async (vmName) => ({ success: true, name: vmName }),
    inspectVm: async (vmName) => ({
      name: vmName,
      exists: true,
      status: 'running',
      ip_address: '192.168.100.50',
      network: { mode: 'nat' },
      snapshots: [],
    }),
    listHostVmNames: async () => [],
    readVmLog: async () => 'vm log line\n',
    reconcileVmNetworking: async () => ({ success: true }),
    restoreVmSnapshot: async (vmName, snapshotId) => ({ success: true, name: vmName, snapshotId }),
    startVm: async (vmName) => ({ success: true, name: vmName }),
    stopVm: async (vmName) => ({ success: true, name: vmName }),
    streamVmLog: async (_vmName, response) => {
      response.status(200).end('streamed');
    },
    parseCreateVmRequest,
    parseNetworkGroupRequest,
    parseVmPolicyRequest,
    formatValidationError,
    isValidationError,
    getRepository: () => mockRepository,
    isDatabaseAvailable: () => true,
    loadStoredVmRuntimeState: async () => null,
    createJobService: () => mockJobService,
    ...overrides,
  };
}

function buildCreatePayload(vmName = 'devbox') {
  return {
    config: {
      vm: {
        name: vmName,
        user: 'matt',
        ram_mb: 4096,
        vcpus: 2,
        disk_gb: 40,
      },
      network: {
        mode: 'nat-auto',
      },
    },
  };
}

test('POST /api/vms enqueues a provision job when jobService is available', async () => {
  const deps = buildDeps();
  const app = createApp(deps);

  const response = await request(app)
    .post('/api/vms')
    .send(buildCreatePayload('async-vm'));

  expect(response.status).toBe(202);
  expect(response.body).toMatchObject({
    vmName: 'async-vm',
    configPath: null,
    job_id: 123,
    status: 'queued',
  });
  expect(deps.upsertStoredVmDefinitionAndEnqueueJob).toHaveBeenCalledWith(
    expect.objectContaining({ vm_name: 'async-vm' }),
    'provision_vm',
    { vmName: 'async-vm' },
    expect.objectContaining({ targetVmId: 'async-vm' }),
  );
});

test('POST /api/vms falls back to sync provisioning when jobService is unavailable', async () => {
  const created = [];
  const deps = buildDeps({
    isDatabaseAvailable: () => false,
    saveVmConfig: async ({ config }) => ({
      vmName: config.vm.name,
      vmDefinitionId: 42,
      configPath: `/configs/${config.vm.name}.yaml`,
      rawConfig: 'vm: {}',
      config,
    }),
    createVm: async (configPath) => {
      created.push(configPath);
      return { success: true, config_path: configPath };
    },
  });
  const app = createApp(deps);

  const response = await request(app)
    .post('/api/vms')
    .send(buildCreatePayload('sync-vm'));

  expect(response.status).toBe(201);
  expect(response.body).toMatchObject({
    vmName: 'sync-vm',
    configPath: '/configs/sync-vm.yaml',
    provisioned: { success: true },
  });
  
  expect(created).toEqual(['/configs/sync-vm.yaml']);
});

test('POST /api/vms/:name/provision enqueues a provision job when jobService is available', async () => {
  const deps = buildDeps({
    inspectVm: async () => ({ name: 'devbox', exists: false, status: 'shut off' }),
  });
  const app = createApp(deps);

  const response = await request(app).post('/api/vms/devbox/provision');

  expect(response.status).toBe(202);
  expect(response.body).toMatchObject({
    name: 'devbox',
    configPath: '/configs/devbox.yaml',
    job_id: 123,
    status: 'queued',
  });
  
  expect(deps.createJobService().enqueueVmProvisionJob).toHaveBeenCalledWith(
    'devbox'
  );
});

test('DELETE /api/vms/:name enqueues a destroy job when jobService is available', async () => {
  const deps = buildDeps();
  const app = createApp(deps);

  const response = await request(app).delete('/api/vms/devbox');

  expect(response.status).toBe(202);
  expect(response.body).toMatchObject({
    name: 'devbox',
    job_id: 124,
    status: 'queued',
  });
  
  expect(deps.createJobService().enqueueVmDestroyJob).toHaveBeenCalledWith('devbox');
});

test('POST /api/vms/:name/clone enqueues a clone job when jobService is available', async () => {
  const deps = buildDeps();
  const app = createApp(deps);

  const response = await request(app)
    .post('/api/vms/devbox/clone')
    .send(buildCreatePayload('clonebox'));

  expect(response.status).toBe(202);
  expect(response.body).toMatchObject({
    sourceName: 'devbox',
    vmName: 'clonebox',
    configPath: null,
    job_id: 125,
    status: 'queued',
  });
  expect(deps.upsertStoredVmDefinitionAndEnqueueJob).toHaveBeenCalledWith(
    expect.objectContaining({ vm_name: 'clonebox' }),
    'clone_vm',
    { sourceVmName: 'devbox', targetVmName: 'clonebox' },
    expect.objectContaining({ targetVmId: 'clonebox' }),
  );
});

test('PATCH /api/vms/:name/policy enqueues a reconcile job when jobService is available', async () => {
  const savedConfigs = [];
  const deps = buildDeps({
    saveVmConfig: async ({ config }) => {
      savedConfigs.push(config);
      return {
        vmName: config.vm.name,
        vmDefinitionId: 42,
        configPath: null,
        rawConfig: 'vm: {}',
        config,
      };
    },
  });
  const app = createApp(deps);

  const response = await request(app)
    .patch('/api/vms/devbox/policy')
    .send({ allow_same_group_traffic: false, allow_private_lan_access: true });

  expect(response.status).toBe(202);
  expect(response.body).toMatchObject({
    vmName: 'devbox',
    configPath: null,
    job_id: 126,
    status: 'queued',
  });
  expect(deps.upsertStoredVmDefinitionAndEnqueueJob).toHaveBeenCalledWith(
    expect.objectContaining({ vm_name: 'devbox' }),
    'reconcile_vm_networking',
    { policyOnly: true },
    expect.objectContaining({ targetVmId: null }),
  );
});

test('GET /api/jobs/:id returns job details', async () => {
  const deps = buildDeps();
  const mockJob = {
    id: 123,
    type: 'provision_vm',
    status: 'running',
    target_host_id: 'test-host',
    target_vm_id: 'test-vm',
    payload: { configPath: '/configs/test-vm.yaml' },
    created_at: new Date(),
  };
  
  deps.createJobService().getJobById.mockResolvedValue(mockJob);
  
  const app = createApp(deps);

  const response = await request(app).get('/api/jobs/123');

  expect(response.status).toBe(200);
  expect(response.body.job).toMatchObject({
    id: 123,
    type: 'provision_vm',
    status: 'running',
  });
  
  expect(deps.createJobService().getJobById).toHaveBeenCalledWith(123);
});

test('GET /api/jobs/:id returns 404 when job not found', async () => {
  const deps = buildDeps();
  deps.createJobService().getJobById.mockResolvedValue(null);
  
  const app = createApp(deps);

  const response = await request(app).get('/api/jobs/999');

  expect(response.status).toBe(404);
  expect(response.body.error).toMatch(/Job not found/);
});

test('GET /api/jobs/:id returns 400 for invalid job ID', async () => {
  const deps = buildDeps();
  const app = createApp(deps);

  const response = await request(app).get('/api/jobs/invalid');

  expect(response.status).toBe(400);
  expect(response.body.error).toMatch(/Job ID must be a valid number/);
});

test('GET /api/jobs/:id returns 503 when jobService is unavailable', async () => {
  const deps = buildDeps({
    isDatabaseAvailable: () => false,
  });
  const app = createApp(deps);

  const response = await request(app).get('/api/jobs/123');

  expect(response.status).toBe(503);
  expect(response.body.error).toMatch(/Job queue is not available/);
});

test('GET /api/jobs/:id/events returns job events', async () => {
  const deps = buildDeps();
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
  
  deps.createJobService().getJobEvents.mockResolvedValue(mockEvents);
  
  const app = createApp(deps);

  const response = await request(app).get('/api/jobs/123/events');

  expect(response.status).toBe(200);
  expect(response.body.events).toHaveLength(2);
  expect(response.body.events[0].message).toBe('Job started');
  
  expect(deps.createJobService().getJobEvents).toHaveBeenCalledWith(123, 100);
});

test('GET /api/jobs/:id/events accepts custom limit', async () => {
  const deps = buildDeps();
  deps.createJobService().getJobEvents.mockResolvedValue([]);
  
  const app = createApp(deps);

  await request(app).get('/api/jobs/123/events?limit=50');

  expect(deps.createJobService().getJobEvents).toHaveBeenCalledWith(123, 50);
});

test('GET /api/jobs/:id/events returns 400 for invalid limit', async () => {
  const deps = buildDeps();
  const app = createApp(deps);

  const response = await request(app).get('/api/jobs/123/events?limit=5000');

  expect(response.status).toBe(400);
  expect(response.body.error).toMatch(/limit must be an integer between 1 and 1000/);
});
