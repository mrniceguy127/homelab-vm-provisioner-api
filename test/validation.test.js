import { expect, test } from 'vitest';

import { parseCreateVmRequest } from '../src/validation.js';

test('accepts a valid VM create request', () => {
  const payload = parseCreateVmRequest({
    config: {
      vm: {
        name: 'devbox',
        user: 'matt',
        owner_user_id: 'user-admin',
        network_group_id: 'ng-test',
        ram_mb: 4096,
        vcpus: 2,
        disk_gb: 40,
        allow_host_access: false,
        trust: 'trusted',
      },
      network: {
        mode: 'nat-auto',
      },
      packages: ['git'],
      ports: [
        {
          host: 2222,
          guest: 22,
          proto: 'tcp',
        },
      ],
    },
    sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey user@example',
    setupScript: '#!/bin/sh\necho ready',
  });

  expect(payload.config.vm.name).toBe('devbox');
  expect(payload.sshPublicKey.startsWith('ssh-ed25519 ')).toBe(true);
  expect(payload.setupScript).toContain('echo ready');
});

test('rejects VM names longer than 63 characters', () => {
  expect(() =>
      parseCreateVmRequest({
        config: {
          vm: {
            name: 'a'.repeat(64),
            user: 'matt',
            ram_mb: 4096,
            vcpus: 2,
            disk_gb: 40,
          },
        },
      })).toThrow(/63 characters or fewer/);
});

test('requires explicit nat-custom network details when subnet_prefix is omitted', () => {
  expect(() =>
      parseCreateVmRequest({
        config: {
          vm: {
            name: 'devbox',
            user: 'matt',
            ram_mb: 4096,
            vcpus: 2,
            disk_gb: 40,
          },
          network: {
            mode: 'nat-custom',
          },
        },
      })).toThrow(/Required when network.mode is nat-custom/);
});

import { parseNetworkGroupRequest, parseVmPolicyRequest, formatValidationError, isValidationError } from '../src/validation.js';

test('parseNetworkGroupRequest accepts valid network group', () => {
  const payload = parseNetworkGroupRequest({
    ownerUserId: 'user-123',
    name: 'demo-group',
    profile: 'isolated_nat',
    bridgeName: 'hvpb-demo',
  });
  expect(payload.name).toBe('demo-group');
});

test('parseNetworkGroupRequest accepts subnetCidr', () => {
  const payload = parseNetworkGroupRequest({
    ownerUserId: 'user-123',
    name: 'demo-group',
    profile: 'isolated_nat',
    subnetCidr: '10.80.5.0/28',
  });
  expect(payload.subnetCidr).toBe('10.80.5.0/28');
});

test('parseNetworkGroupRequest rejects invalid subnetCidr', () => {
  expect(() => {
    parseNetworkGroupRequest({
      ownerUserId: 'user-123',
      name: 'demo-group',
      profile: 'isolated_nat',
      subnetCidr: 'not-a-cidr',
    });
  }).toThrow();
});

test('parseVmPolicyRequest accepts valid policy', () => {
  const payload = parseVmPolicyRequest({
    allow_host_access: true,
  });
  expect(payload.allow_host_access).toBe(true);
});

test('formatValidationError formats ZodError', () => {
  try {
    parseNetworkGroupRequest({});
  } catch (error) {
    const formatted = formatValidationError(error);
    expect(Array.isArray(formatted)).toBe(true);
    expect(formatted.length).toBeGreaterThan(0);
  }
});

test('isValidationError identifies ZodError', () => {
  try {
    parseNetworkGroupRequest({});
  } catch (error) {
    expect(isValidationError(error)).toBe(true);
  }
  expect(isValidationError(new Error('test'))).toBe(false);
});
