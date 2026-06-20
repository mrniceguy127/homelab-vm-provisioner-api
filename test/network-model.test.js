import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import yaml from 'js-yaml';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

async function loadNetworkModel(tempProvisionerRoot) {
  process.env.PROVISIONER_CLI_PATH = tempProvisionerRoot;
  vi.resetModules();
  return import('../src/network-model.js');
}

let tempRoot = '';

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hvp-network-model-'));
});

afterEach(async () => {
  delete process.env.PROVISIONER_CLI_PATH;
  vi.resetModules();
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('allocateSubnetFromPool skips overlapping subnets inside the global pool', async () => {
  const networkModel = await loadNetworkModel(tempRoot);

  expect(
    networkModel.allocateSubnetFromPool([
      { subnet_cidr: '10.80.0.0/28' },
      { subnet_cidr: '10.80.0.16/28' },
    ]),
  ).toBe('10.80.0.32/28');
});

test('createNetworkGroup rejects overlapping subnet allocations', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  await networkModel.ensureDefaultUser();

  await networkModel.createNetworkGroup({
    ownerUserId: networkModel.DEFAULT_ADMIN_USER_ID,
    name: 'group-a',
    profile: 'isolated_nat',
    subnetCidr: '10.80.1.0/28',
  });

  await expect(
    networkModel.createNetworkGroup({
      ownerUserId: networkModel.DEFAULT_ADMIN_USER_ID,
      name: 'group-b',
      profile: 'isolated_nat',
      subnetCidr: '10.80.1.8/29',
    }),
  ).rejects.toThrow(/overlaps an existing allocation/i);
});

test('prepareVmConfigForSave assigns a VM IP inside the selected network-group subnet', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  await networkModel.ensureDefaultUser();
  const networkGroup = await networkModel.createNetworkGroup({
    ownerUserId: networkModel.DEFAULT_ADMIN_USER_ID,
    name: 'team-a',
    profile: 'isolated_nat',
    subnetCidr: '10.80.5.0/28',
  });

  const prepared = await networkModel.prepareVmConfigForSave({
    config: {
      vm: {
        name: 'alpha',
        user: 'matt',
        ram_mb: 4096,
        vcpus: 2,
        disk_gb: 40,
        owner_user_id: networkModel.DEFAULT_ADMIN_USER_ID,
        network_group_id: networkGroup.id,
      },
    },
  });

  expect(prepared.config.vm.ip_address).toBe('10.80.5.2');
  expect(prepared.config.network.subnet_cidr).toBe('10.80.5.0/28');
  expect(prepared.config.network.vm_ip).toBe('10.80.5.2');
  expect(prepared.config.vm.mac_address).toMatch(/^52:54:00:/);
});

test('initializeNetworkModel migrates legacy single-admin VM state into owner and network-group metadata', async () => {
  const configRoot = path.join(tempRoot, 'data', 'configs');
  const stateRoot = path.join(tempRoot, 'data', 'vm', 'state');
  await fs.mkdir(configRoot, { recursive: true });
  await fs.mkdir(stateRoot, { recursive: true });

  await fs.writeFile(
    path.join(configRoot, 'demo.yaml'),
    yaml.dump({
      vm: {
        name: 'demo',
        user: 'matt',
        ram_mb: 4096,
        vcpus: 2,
        disk_gb: 40,
      },
      network: {
        mode: 'nat-auto',
      },
    }),
    'utf8',
  );
  await fs.writeFile(
    path.join(stateRoot, 'demo.yaml'),
    yaml.dump({
      config_path: path.join(configRoot, 'demo.yaml'),
      network: {
        mode: 'nat',
        name: 'demo-net',
        bridge_name: 'virbr-demo',
        cidr: '192.168.240.0/24',
        gateway: '192.168.240.1',
        vm_ip: '192.168.240.50',
        dhcp_start: '192.168.240.50',
        dhcp_end: '192.168.240.99',
        mac: '52:54:00:11:22:33',
      },
    }),
    'utf8',
  );

  const networkModel = await loadNetworkModel(tempRoot);
  await networkModel.initializeNetworkModel();

  const migratedConfig = yaml.load(await fs.readFile(path.join(configRoot, 'demo.yaml'), 'utf8'));
  const networkGroups = await networkModel.listNetworkGroups();
  const users = await networkModel.listUsers();

  expect(users).toEqual([
    expect.objectContaining({ id: 'user-admin', role: 'admin' }),
  ]);
  expect(networkGroups).toEqual([
    expect.objectContaining({
      owner_user_id: 'user-admin',
      subnet_cidr: '192.168.240.0/24',
    }),
  ]);
  expect(migratedConfig.vm.owner_user_id).toBe('user-admin');
  expect(migratedConfig.vm.network_group_id).toBe(networkGroups[0].id);
  expect(migratedConfig.vm.mac_address).toBe('52:54:00:11:22:33');
  expect(migratedConfig.vm.ip_address).toBe('192.168.240.50');
});
