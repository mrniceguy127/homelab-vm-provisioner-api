// Set required environment variables before imports
process.env.PROVISIONER_CLI_PATH = '/test/provisioner-cli';
process.env.PROVISIONER_DATA_DIR = '/test/provisioner/data';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mockUsers = [];
const mockNetworkGroups = [];

vi.mock('../src/db.js', () => ({
  listStoredUsers: vi.fn(async () => [...mockUsers]),
  upsertStoredUser: vi.fn(async (user) => {
    const index = mockUsers.findIndex((entry) => entry.id === user.id);
    if (index >= 0) {
      mockUsers[index] = { ...mockUsers[index], ...user };
      return mockUsers[index];
    }
    mockUsers.push(user);
    return user;
  }),
  listStoredNetworkGroups: vi.fn(async () => [...mockNetworkGroups]),
  upsertStoredNetworkGroup: vi.fn(async (group) => {
    const index = mockNetworkGroups.findIndex((entry) => entry.id === group.id);
    if (index >= 0) {
      mockNetworkGroups[index] = { ...mockNetworkGroups[index], ...group };
      return mockNetworkGroups[index];
    }
    mockNetworkGroups.push(group);
    return group;
  }),
  listStoredVmDefinitions: vi.fn(async () => []),
}));

async function loadNetworkModel(tempProvisionerRoot) {
  process.env.PROVISIONER_CLI_PATH = tempProvisionerRoot;
  vi.resetModules();
  return import('../src/network-model.js');
}

let tempRoot = '';

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hvp-network-model-'));
  mockUsers.length = 0;
  mockNetworkGroups.length = 0;
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
    subnetCidr: '10.80.1.0/29',
  });

  await expect(
    networkModel.createNetworkGroup({
      ownerUserId: networkModel.DEFAULT_ADMIN_USER_ID,
      name: 'group-b',
      profile: 'isolated_nat',
      subnetCidr: '10.80.1.0/30',
    }),
  ).rejects.toThrow(/overlaps/i);
});

test('prepareVmConfigForSave assigns a VM IP inside the selected network-group subnet', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  await networkModel.ensureDefaultUser();
  const networkGroup = await networkModel.createNetworkGroup({
    ownerUserId: networkModel.DEFAULT_ADMIN_USER_ID,
    name: 'team-a',
    profile: 'isolated_nat',
    subnetCidr: '10.80.5.0/29',
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
  expect(prepared.config.network.subnet_cidr).toBe('10.80.5.0/29');
  expect(prepared.config.network.vm_ip).toBe('10.80.5.2');
  expect(prepared.config.vm.mac_address).toMatch(/^52:54:00:/);
});

// Utility function tests
test('ipv4ToInt converts IP address to integer', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  expect(networkModel.ipv4ToInt('10.80.0.1')).toBe(173015041);
  expect(networkModel.ipv4ToInt('192.168.1.1')).toBe(3232235777);
  expect(networkModel.ipv4ToInt('0.0.0.0')).toBe(0);
});

test('intToIpv4 converts integer to IP address', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  expect(networkModel.intToIpv4(173015041)).toBe('10.80.0.1');
  expect(networkModel.intToIpv4(3232235777)).toBe('192.168.1.1');
  expect(networkModel.intToIpv4(0)).toBe('0.0.0.0');
});

test('parseCidr parses valid CIDR notation', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  const result = networkModel.parseCidr('10.80.0.0/28');
  expect(result.cidr).toBe('10.80.0.0/28');
  expect(result.prefixLength).toBe(28);
  expect(result.address).toBe('10.80.0.0');
});

test('parseCidr throws on invalid CIDR', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  expect(() => networkModel.parseCidr('invalid')).toThrow(/Invalid CIDR/);
  expect(() => networkModel.parseCidr('10.80.0.0/33')).toThrow(/Invalid CIDR/);
  expect(() => networkModel.parseCidr('10.80.0.0/-1')).toThrow(/Invalid CIDR/);
  expect(() => networkModel.parseCidr('')).toThrow(/Invalid CIDR/);
});

test('parseCidr handles /0 prefix', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  const result = networkModel.parseCidr('0.0.0.0/0');
  expect(result.prefixLength).toBe(0);
  expect(result.networkInt).toBe(0);
});

test('parseCidr handles /31 and /32 subnets', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  const result31 = networkModel.parseCidr('10.80.0.0/31');
  expect(result31.firstHostInt).toBe(result31.networkInt);
  expect(result31.lastHostInt).toBe(result31.broadcastInt);
  
  const result32 = networkModel.parseCidr('10.80.0.1/32');
  expect(result32.firstHostInt).toBe(result32.networkInt);
  expect(result32.lastHostInt).toBe(result32.broadcastInt);
});

test('cidrsOverlap detects overlapping networks', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  expect(networkModel.cidrsOverlap('10.80.0.0/28', '10.80.0.8/29')).toBe(true);
  expect(networkModel.cidrsOverlap('10.80.0.0/28', '10.80.0.16/28')).toBe(false);
});

test('cidrContainsIp checks if IP is in CIDR', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  expect(networkModel.cidrContainsIp('10.80.0.0/28', '10.80.0.5')).toBe(true);
  expect(networkModel.cidrContainsIp('10.80.0.0/28', '10.80.0.20')).toBe(false);
});

test('buildDhcpRange generates gateway and DHCP range', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  const range = networkModel.buildDhcpRange('10.80.0.0/28');
  expect(range.gatewayIp).toBe('10.80.0.1');
  expect(range.dhcpStart).toBe('10.80.0.2');
  expect(range.dhcpEnd).toBe('10.80.0.14');
});

test('buildDhcpRange throws on subnet too small', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  expect(() => networkModel.buildDhcpRange('10.80.0.0/32')).toThrow(/does not have enough host capacity/);
});

test('allocateSubnetFromPool throws on invalid prefix length', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  expect(() => networkModel.allocateSubnetFromPool([], '10.80.0.0/16', 15)).toThrow(/Invalid network-group prefix length/);
  expect(() => networkModel.allocateSubnetFromPool([], '10.80.0.0/16', 31)).toThrow(/Invalid network-group prefix length/);
});

test('allocateSubnetFromPool returns first subnet when pool is empty', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  const allocated = networkModel.allocateSubnetFromPool([], '10.80.0.0/24', 28);
  expect(allocated).toBe('10.80.0.0/28');
});

test('loadVmStateRecord returns empty object', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  const state = await networkModel.loadVmStateRecord('any-vm');
  expect(state).toEqual({});
});

test('listUsers retrieves users from storage', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  mockUsers.push({ id: 'user-1', username: 'testuser' });
  const users = await networkModel.listUsers();
  expect(users).toEqual([{ id: 'user-1', username: 'testuser' }]);
});

test('ensureDefaultUser creates default admin user if not exists', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  const defaultUser = await networkModel.ensureDefaultUser();
  expect(defaultUser.id).toBe(networkModel.DEFAULT_ADMIN_USER_ID);
  expect(defaultUser.role).toBe('admin');
});

test('ensureDefaultUser returns existing admin user', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  const firstCall = await networkModel.ensureDefaultUser();
  const secondCall = await networkModel.ensureDefaultUser();
  expect(secondCall.id).toBe(firstCall.id);
});

test('listNetworkGroups retrieves network groups from storage', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  mockNetworkGroups.push({ id: 'group-1', name: 'test-group' });
  const groups = await networkModel.listNetworkGroups();
  expect(groups).toEqual([{ id: 'group-1', name: 'test-group' }]);
});

test('createNetworkGroup throws when ownerUserId is missing', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  await networkModel.ensureDefaultUser();
  
  await expect(
    networkModel.createNetworkGroup({
      name: 'test-group',
      profile: 'isolated_nat',
    })
  ).rejects.toThrow(/ownerUserId and name are required/);
});

test('createNetworkGroup throws when name is missing', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  await networkModel.ensureDefaultUser();
  
  await expect(
    networkModel.createNetworkGroup({
      ownerUserId: networkModel.DEFAULT_ADMIN_USER_ID,
      profile: 'isolated_nat',
    })
  ).rejects.toThrow(/ownerUserId and name are required/);
});

test('createNetworkGroup throws when owner user does not exist', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  
  await expect(
    networkModel.createNetworkGroup({
      ownerUserId: 'nonexistent-user',
      name: 'test-group',
      profile: 'isolated_nat',
    })
  ).rejects.toThrow(/Unknown owner user/);
});

test('createNetworkGroup throws when network group already exists', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  await networkModel.ensureDefaultUser();
  
  await networkModel.createNetworkGroup({
    ownerUserId: networkModel.DEFAULT_ADMIN_USER_ID,
    name: 'test-group',
    profile: 'isolated_nat',
  });
  
  await expect(
    networkModel.createNetworkGroup({
      ownerUserId: networkModel.DEFAULT_ADMIN_USER_ID,
      name: 'test-group',
      profile: 'isolated_nat',
    })
  ).rejects.toThrow(/Network group already exists/);
});

// TDD: CIDR Validation Tests
test('validateCidrFormat accepts valid CIDR notation', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  
  expect(() => networkModel.validateCidrFormat('10.80.0.0/28')).not.toThrow();
  expect(() => networkModel.validateCidrFormat('192.168.1.0/24')).not.toThrow();
  expect(() => networkModel.validateCidrFormat('10.0.0.0/29')).not.toThrow();
});

test('validateCidrFormat rejects invalid CIDR notation', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  
  expect(() => networkModel.validateCidrFormat('not-a-cidr')).toThrow(/Invalid CIDR format/i);
  expect(() => networkModel.validateCidrFormat('10.80.0.0')).toThrow(/Invalid CIDR format/i);
  expect(() => networkModel.validateCidrFormat('10.80.0.0/33')).toThrow(/Invalid CIDR format/i);
  expect(() => networkModel.validateCidrFormat('256.0.0.0/24')).toThrow(/Invalid CIDR format/i);
  expect(() => networkModel.validateCidrFormat('10.80.0.1/28')).toThrow(/must be a network address/i);
});

test('validateCidrSize rejects subnets larger than 8 IPs', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  
  expect(() => networkModel.validateCidrSize('10.80.0.0/28')).toThrow(/must be at most 8 IP addresses/i);
  expect(() => networkModel.validateCidrSize('10.80.0.0/24')).toThrow(/must be at most 8 IP addresses/i);
  expect(() => networkModel.validateCidrSize('10.80.0.0/16')).toThrow(/must be at most 8 IP addresses/i);
});

test('validateCidrSize accepts subnets with 8 or fewer IPs', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  
  expect(() => networkModel.validateCidrSize('10.80.0.0/29')).not.toThrow(); // 8 IPs
  expect(() => networkModel.validateCidrSize('10.80.0.0/30')).not.toThrow(); // 4 IPs
  expect(() => networkModel.validateCidrSize('10.80.0.0/31')).not.toThrow(); // 2 IPs
  expect(() => networkModel.validateCidrSize('10.80.0.8/32')).not.toThrow(); // 1 IP
});

test('validateCidrWithinGlobalPool accepts CIDRs within global pool', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  
  // Default pool is 10.80.0.0/16
  expect(() => networkModel.validateCidrWithinGlobalPool('10.80.0.0/29')).not.toThrow();
  expect(() => networkModel.validateCidrWithinGlobalPool('10.80.255.0/29')).not.toThrow();
  expect(() => networkModel.validateCidrWithinGlobalPool('10.80.128.0/29')).not.toThrow();
});

test('validateCidrWithinGlobalPool rejects CIDRs outside global pool', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  
  // Default pool is 10.80.0.0/16
  expect(() => networkModel.validateCidrWithinGlobalPool('10.81.0.0/29'))
    .toThrow(/must be within the global pool/i);
  expect(() => networkModel.validateCidrWithinGlobalPool('10.79.0.0/29'))
    .toThrow(/must be within the global pool/i);
  expect(() => networkModel.validateCidrWithinGlobalPool('192.168.1.0/29'))
    .toThrow(/must be within the global pool/i);
});

test('validateCidrWithinGlobalPool accepts custom pool configuration', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  
  expect(() => networkModel.validateCidrWithinGlobalPool('192.168.100.0/29', '192.168.0.0/16'))
    .not.toThrow();
  expect(() => networkModel.validateCidrWithinGlobalPool('192.168.100.0/29', '10.80.0.0/16'))
    .toThrow(/must be within the global pool/i);
});

test('validateCidrOverlap detects overlapping CIDRs', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  await networkModel.ensureDefaultUser();
  
  await networkModel.createNetworkGroup({
    ownerUserId: networkModel.DEFAULT_ADMIN_USER_ID,
    name: 'existing-group',
    profile: 'isolated_nat',
    subnetCidr: '10.80.1.0/29',
  });
  
  const networkGroups = await networkModel.listNetworkGroups();
  
  // Exact overlap
  expect(() => networkModel.validateCidrOverlap('10.80.1.0/29', networkGroups))
    .toThrow(/overlaps with existing network group/i);
  
  // Partial overlap
  expect(() => networkModel.validateCidrOverlap('10.80.1.0/28', networkGroups))
    .toThrow(/overlaps with existing network group/i);
  expect(() => networkModel.validateCidrOverlap('10.80.1.4/30', networkGroups))
    .toThrow(/overlaps with existing network group/i);
});

test('validateCidrOverlap accepts non-overlapping CIDRs', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  await networkModel.ensureDefaultUser();
  
  await networkModel.createNetworkGroup({
    ownerUserId: networkModel.DEFAULT_ADMIN_USER_ID,
    name: 'existing-group',
    profile: 'isolated_nat',
    subnetCidr: '10.80.1.0/29',
  });
  
  const networkGroups = await networkModel.listNetworkGroups();
  
  expect(() => networkModel.validateCidrOverlap('10.80.2.0/29', networkGroups))
    .not.toThrow();
  expect(() => networkModel.validateCidrOverlap('10.80.1.8/29', networkGroups))
    .not.toThrow();
});

test('validateNetworkGroupCidr performs all validations', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  await networkModel.ensureDefaultUser();
  
  await networkModel.createNetworkGroup({
    ownerUserId: networkModel.DEFAULT_ADMIN_USER_ID,
    name: 'existing-group',
    profile: 'isolated_nat',
    subnetCidr: '10.80.1.0/29',
  });
  
  const networkGroups = await networkModel.listNetworkGroups();
  
  // Valid CIDR
  expect(() => networkModel.validateNetworkGroupCidr('10.80.2.0/29', networkGroups))
    .not.toThrow();
  
  // Invalid format
  expect(() => networkModel.validateNetworkGroupCidr('not-a-cidr', networkGroups))
    .toThrow(/Invalid CIDR format/i);
  
  // Too large
  expect(() => networkModel.validateNetworkGroupCidr('10.80.3.0/28', networkGroups))
    .toThrow(/must be at most 8 IP addresses/i);
  
  // Outside global pool
  expect(() => networkModel.validateNetworkGroupCidr('192.168.1.0/29', networkGroups))
    .toThrow(/must be within the global pool/i);
  
  // Overlapping
  expect(() => networkModel.validateNetworkGroupCidr('10.80.1.0/29', networkGroups))
    .toThrow(/overlaps with existing network group/i);
});

test('createNetworkGroup enforces CIDR validation for custom subnets', async () => {
  const networkModel = await loadNetworkModel(tempRoot);
  await networkModel.ensureDefaultUser();
  
  // Too large
  await expect(
    networkModel.createNetworkGroup({
      ownerUserId: networkModel.DEFAULT_ADMIN_USER_ID,
      name: 'test-large',
      profile: 'isolated_nat',
      subnetCidr: '10.80.10.0/28',
    })
  ).rejects.toThrow(/must be at most 8 IP addresses/i);
  
  // Outside global pool
  await expect(
    networkModel.createNetworkGroup({
      ownerUserId: networkModel.DEFAULT_ADMIN_USER_ID,
      name: 'test-outside',
      profile: 'isolated_nat',
      subnetCidr: '192.168.1.0/29',
    })
  ).rejects.toThrow(/must be within the global pool/i);
  
  // Invalid format
  await expect(
    networkModel.createNetworkGroup({
      ownerUserId: networkModel.DEFAULT_ADMIN_USER_ID,
      name: 'test-invalid',
      profile: 'isolated_nat',
      subnetCidr: 'invalid',
    })
  ).rejects.toThrow(/Invalid CIDR format/i);
});

