import { expect, test } from 'vitest';

import { parseCreateVmRequest } from '../src/validation.js';

test('accepts a valid VM create request', () => {
  const payload = parseCreateVmRequest({
    config: {
      vm: {
        name: 'devbox',
        user: 'matt',
        ram_mb: 4096,
        vcpus: 2,
        disk_gb: 40,
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
  });

  expect(payload.config.vm.name).toBe('devbox');
  expect(payload.sshPublicKey.startsWith('ssh-ed25519 ')).toBe(true);
});

test('rejects VM names longer than 12 characters', () => {
  expect(() =>
      parseCreateVmRequest({
        config: {
          vm: {
            name: 'name-too-long',
            user: 'matt',
            ram_mb: 4096,
            vcpus: 2,
            disk_gb: 40,
          },
        },
      })).toThrow(/12 characters or fewer/);
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
