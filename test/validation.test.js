import test from 'node:test';
import assert from 'node:assert/strict';

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

  assert.equal(payload.config.vm.name, 'devbox');
  assert.equal(payload.sshPublicKey.startsWith('ssh-ed25519 '), true);
});

test('rejects VM names longer than 12 characters', () => {
  assert.throws(
    () =>
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
      }),
    /12 characters or fewer/,
  );
});

test('requires explicit nat-custom network details when subnet_prefix is omitted', () => {
  assert.throws(
    () =>
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
      }),
    /Required when network.mode is nat-custom/,
  );
});
