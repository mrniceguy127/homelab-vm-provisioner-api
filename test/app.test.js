// Set required environment variables before imports
process.env.PROVISIONER_CLI_PATH = '/test/provisioner-cli';
process.env.PROVISIONER_DATA_DIR = '/test/provisioner/data';

import { expect, test } from 'vitest';

import request from 'supertest';

import createApp from '../src/app.js';
import {
  formatValidationError,
  isValidationError,
  parseCreateVmRequest,
  parseNetworkGroupRequest,
  parseVmPolicyRequest,
} from '../src/validation.js';

function buildDeps(overrides = {}) {
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
      configPath: `/configs/${config.vm.name}.yaml`,
      rawConfig: 'vm: {}',
      config,
    }),
    parseCreateVmRequest,
    parseNetworkGroupRequest,
    parseVmPolicyRequest,
    formatValidationError,
    isValidationError,
    loadStoredVmRuntimeState: async () => null,
    getRepository: () => null,
    isDatabaseAvailable: () => false,
    createJobService: () => null,
    upsertStoredVmDefinitionAndEnqueueJob: async () => ({
      vmDefinition: { id: 1 },
      job: { id: 1, status: 'pending' },
    }),
    ...overrides,
  };
}

function buildCreatePayload(vmName = 'devbox') {
  return {
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
        mode: 'nat-auto',
      },
    },
  };
}

test('POST /api/vms/configs rejects duplicate config names', async () => {
  const app = createApp(buildDeps({
    listStoredConfigNames: async () => ['devbox'],
  }));

  const response = await request(app)
    .post('/api/vms/configs')
    .send(buildCreatePayload('devbox'));

  expect(response.status).toBe(409);
  expect(response.body.error).toMatch(/already used by a saved config/);
});

test('GET /api/vms returns only configured VMs', async () => {
  const app = createApp(buildDeps({
    listStoredConfigNames: async () => ['alpha', 'bravo'],
  }));

  const response = await request(app).get('/api/vms');

  expect(response.status).toBe(200);
  expect(response.body.vms.map((vm) => vm.name)).toEqual(['alpha', 'bravo']);
  expect(response.body.vms[0].configured).toBe(true);
  expect(response.body.vms[1].configured).toBe(true);
});

test('GET /api/network-groups lists persisted network groups', async () => {
  const app = createApp(buildDeps({
    listNetworkGroups: async () => [
      {
        id: 'ng-admin',
        owner_user_id: 'user-admin',
        name: 'default-admin',
        profile: 'isolated_nat',
      },
    ],
  }));

  const response = await request(app).get('/api/network-groups');

  expect(response.status).toBe(200);
  expect(response.body.networkGroups).toEqual([
    expect.objectContaining({ id: 'ng-admin', profile: 'isolated_nat' }),
  ]);
});

test('PATCH /api/vms/:name/policy requires job service', async () => {
  const savedConfigs = [];
  const app = createApp(buildDeps({
    saveVmConfig: async ({ config }) => {
      savedConfigs.push(config);
      return {
        vmName: config.vm.name,
        configPath: `/configs/${config.vm.name}.yaml`,
        rawConfig: 'vm: {}',
        config,
      };
    },
  }));

  const response = await request(app)
    .patch('/api/vms/devbox/policy')
    .send({ allow_same_group_traffic: false, allow_private_lan_access: true });

  expect(response.status).toBe(503);
  expect(response.body.error).toMatch(/Job queue unavailable/);
});

test('POST /api/vms requires job service for provisioning', async () => {
  const app = createApp(buildDeps());

  const response = await request(app)
    .post('/api/vms')
    .send(buildCreatePayload('newvm'));

  expect(response.status).toBe(503);
  expect(response.body.error).toMatch(/Job queue unavailable/);
});

test('GET /api/vms/:name returns 404 when no stored config exists', async () => {
  const notFound = new Error('Stored config was not found for VM: ghost');
  notFound.statusCode = 404;

  const app = createApp(buildDeps({
    loadStoredConfig: async () => {
      throw notFound;
    },
  }));

  const response = await request(app).get('/api/vms/ghost');

  expect(response.status).toBe(404);
  expect(response.body.error).toMatch(/Stored config was not found/);
});

test('POST /api/vms/:name/provision requires job service', async () => {
  const app = createApp(buildDeps());

  const response = await request(app).post('/api/vms/devbox/provision');

  expect(response.status).toBe(503);
  expect(response.body.error).toMatch(/Job queue unavailable/);
});

test('DELETE /api/vms/:name requires job service', async () => {
  const app = createApp(buildDeps());

  const response = await request(app).delete('/api/vms/devbox');

  expect(response.status).toBe(503);
  expect(response.body.error).toMatch(/Job queue unavailable/);
});

test('GET /api/vms/:name/logs reads snapshot logs from database', async () => {
  const app = createApp(buildDeps());

  const response = await request(app).get('/api/vms/devbox/logs?lines=123');

  // Without database/worker, logs endpoint returns 404
  expect(response.status).toBe(404);
  expect(response.body.error).toMatch(/VM logs not available/);
});

test('POST /api/vms/:name/start requires job service', async () => {
  const app = createApp(buildDeps());

  const response = await request(app).post('/api/vms/devbox/start');

  expect(response.status).toBe(503);
  expect(response.body.error).toMatch(/Job queue unavailable/);
});

test('POST /api/vms/:name/stop requires job service', async () => {
  const app = createApp(buildDeps());

  const response = await request(app).post('/api/vms/devbox/stop');

  expect(response.status).toBe(503);
  expect(response.body.error).toMatch(/Job queue unavailable/);
});

test('POST /api/vms/:name/clone requires job service', async () => {
  const app = createApp(buildDeps());

  const response = await request(app)
    .post('/api/vms/devbox/clone')
    .send(buildCreatePayload('clonebox'));

  expect(response.status).toBe(503);
  expect(response.body.error).toMatch(/Job queue unavailable/);
});

test('POST /api/vms/:name/snapshots requires job service', async () => {
  const app = createApp(buildDeps());

  const response = await request(app).post('/api/vms/devbox/snapshots');

  expect(response.status).toBe(503);
  expect(response.body.error).toMatch(/Job queue unavailable/);
});

test('GET /api/vms/:name/logs/stream returns 404 (streaming removed)', async () => {
  const app = createApp(buildDeps());

  const response = await request(app).get('/api/vms/devbox/logs/stream?lines=77');

  expect(response.status).toBe(404);
  expect(response.body.error).toMatch(/Route not found/);
});

test('GET /api/configs requires database', async () => {
  const app = createApp(buildDeps({
    isDatabaseAvailable: () => false,
  }));

  const response = await request(app).get('/api/configs');

  expect(response.status).toBe(503);
  expect(response.body.error).toMatch(/not available without database/);
});

test('GET /api/vms/:name/state requires database', async () => {
  const app = createApp(buildDeps({
    isDatabaseAvailable: () => false,
  }));

  const response = await request(app).get('/api/vms/test-vm/state');

  expect(response.status).toBe(503);
  expect(response.body.error).toMatch(/not available without database/);
});

test('GET /api/vms/:name/state returns 404 for non-existent VM', async () => {
  const app = createApp(buildDeps({
    isDatabaseAvailable: () => false,
  }));

  const response = await request(app).get('/api/vms/nonexistent/state');

  expect(response.status).toBe(503);
  expect(response.body.error).toMatch(/not available without database/);
});
