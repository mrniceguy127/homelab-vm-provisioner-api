import { expect, test } from 'vitest';

import request from 'supertest';

import { createApp } from '../src/app.js';
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

test('POST /api/vms/configs rejects duplicate host VM names', async () => {
  const app = createApp(buildDeps({
    listHostVmNames: async () => ['devbox'],
  }));

  const response = await request(app)
    .post('/api/vms/configs')
    .send(buildCreatePayload('devbox'));

  expect(response.status).toBe(409);
  expect(response.body.error).toMatch(/libvirt VM on this host/);
});

test('GET /api/vms returns only configured VMs', async () => {
  const app = createApp(buildDeps({
    listStoredConfigNames: async () => ['alpha', 'bravo'],
    inspectVm: async (vmName) => {
      if (vmName === 'alpha') {
        return { name: 'alpha', exists: true, status: 'running' };
      }

      throw new Error('virsh lookup failed');
    },
  }));

  const response = await request(app).get('/api/vms');

  expect(response.status).toBe(200);
  expect(response.body.vms.map((vm) => vm.name)).toEqual(['alpha', 'bravo']);
  expect(response.body.vms[1].configured).toBe(true);
  expect(response.body.vms[1].provisionerError).toMatch(/virsh lookup failed/);
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

test('PATCH /api/vms/:name/policy updates stored VM policy flags', async () => {
  const savedConfigs = [];
  const reconcileCalls = [];
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
    reconcileVmNetworking: async (options) => {
      reconcileCalls.push(options);
      return { success: true };
    },
  }));

  const response = await request(app)
    .patch('/api/vms/devbox/policy')
    .send({ allow_same_group_traffic: false, allow_private_lan_access: true });

  expect(response.status).toBe(200);
  expect(savedConfigs).toEqual([
    expect.objectContaining({
      vm: expect.objectContaining({
        name: 'devbox',
        allow_same_group_traffic: false,
        allow_private_lan_access: true,
      }),
    }),
  ]);
  expect(reconcileCalls).toEqual([{ policyOnly: true }]);
});

test('POST /api/vms rolls back saved config artifacts when provisioning fails', async () => {
  const deleted = [];
  const app = createApp(buildDeps({
    createVm: async () => {
      throw new Error('network reconcile failed');
    },
    deleteSavedConfigArtifacts: async (savedConfig) => {
      deleted.push(savedConfig.configPath);
    },
  }));

  const response = await request(app)
    .post('/api/vms')
    .send(buildCreatePayload('rollback'));

  expect(response.status).toBe(500);
  expect(response.body.error).toMatch(/network reconcile failed/);
  expect(deleted).toEqual(['/configs/rollback.yaml']);
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

test('POST /api/vms/:name/provision provisions the saved config', async () => {
  const created = [];
  const app = createApp(buildDeps({
    createVm: async (configPath) => {
      created.push(configPath);
      return { success: true, config_path: configPath };
    },
    inspectVm: async () => ({ name: 'devbox', exists: false, status: 'shut off' }),
  }));

  const response = await request(app).post('/api/vms/devbox/provision');

  expect(response.status).toBe(201);
  expect(created).toEqual(['/configs/devbox.yaml']);
  expect(response.body.name).toBe('devbox');
});

test('DELETE /api/vms/:name requires a stored config and calls destroy', async () => {
  const destroyed = [];
  const app = createApp(buildDeps({
    destroyVm: async (vmName) => {
      destroyed.push(vmName);
      return { success: true, name: vmName };
    },
  }));

  const response = await request(app).delete('/api/vms/devbox');

  expect(response.status).toBe(200);
  expect(destroyed).toEqual(['devbox']);
});

test('GET /api/vms/:name/logs reads snapshot logs for configured VMs', async () => {
  const app = createApp(buildDeps({
    readVmLog: async (vmName, lines) => `${vmName}:${lines}`,
  }));

  const response = await request(app).get('/api/vms/devbox/logs?lines=123');

  expect(response.status).toBe(200);
  expect(response.body.log).toBe('devbox:123');
});

test('POST /api/vms/:name/start delegates to the power-on dependency', async () => {
  const started = [];
  const app = createApp(buildDeps({
    startVm: async (vmName) => {
      started.push(vmName);
      return { success: true, name: vmName };
    },
  }));

  const response = await request(app).post('/api/vms/devbox/start');

  expect(response.status).toBe(200);
  expect(started).toEqual(['devbox']);
});

test('POST /api/vms/:name/clone saves the target config and delegates cloning', async () => {
  const cloned = [];
  const app = createApp(buildDeps({
    cloneVm: async (sourceVmName, configPath) => {
      cloned.push([sourceVmName, configPath]);
      return { success: true, source_name: sourceVmName, config_path: configPath };
    },
  }));

  const response = await request(app)
    .post('/api/vms/devbox/clone')
    .send(buildCreatePayload('clonebox'));

  expect(response.status).toBe(201);
  expect(cloned).toEqual([['devbox', '/configs/clonebox.yaml']]);
});

test('POST /api/vms/:name/snapshots creates a restore point', async () => {
  const snapshots = [];
  const app = createApp(buildDeps({
    createVmSnapshot: async (vmName) => {
      snapshots.push(vmName);
      return { success: true, name: vmName };
    },
  }));

  const response = await request(app).post('/api/vms/devbox/snapshots');

  expect(response.status).toBe(201);
  expect(snapshots).toEqual(['devbox']);
});

test('GET /api/vms/:name/logs/stream delegates to the streaming dependency', async () => {
  const app = createApp(buildDeps({
    streamVmLog: async (vmName, response, lines) => {
      response.status(200).json({ vmName, lines, streamed: true });
    },
  }));

  const response = await request(app).get('/api/vms/devbox/logs/stream?lines=77');

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ vmName: 'devbox', lines: 77, streamed: true });
});
