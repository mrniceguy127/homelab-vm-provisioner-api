import net from 'node:net';

import { ZodError, z } from 'zod';

function isIpAddress(value) {
  return net.isIP(value) !== 0;
}

function isIpv4Address(value) {
  return net.isIP(value) === 4;
}

function isIpv4Prefix(value) {
  const parts = value.split('.');
  return parts.length === 3 && parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function isIpv4Slash24(value) {
  const [address, prefixLength] = value.split('/');
  return prefixLength === '24' && isIpv4Address(address);
}

const ipAddressSchema = z.string().trim().refine(isIpAddress, 'Must be a valid IP address');

const portSchema = z
  .number()
  .int()
  .min(1, 'Must be between 1 and 65535')
  .max(65535, 'Must be between 1 and 65535');

const vmSchema = z
  .object({
    name: z.string().trim().min(1).max(12, 'VM names must be 12 characters or fewer'),
    user: z.string().trim().min(1),
    ssh_key_file: z.string().trim().min(1).optional(),
    ram_mb: z.number().int().positive(),
    vcpus: z.number().int().positive(),
    disk_gb: z.number().int().positive(),
    allow_sudo: z.boolean().optional(),
    trust: z.enum(['trusted', 'untrusted']).optional(),
    template: z.string().trim().min(1).optional(),
  })
  .strict();

const networkSchema = z
  .object({
    mode: z.enum(['nat-auto', 'nat-custom', 'bridge']).optional(),
    subnet_prefix: z.string().trim().refine(isIpv4Prefix, 'Must look like 192.168.240').optional(),
    cidr: z.string().trim().refine(isIpv4Slash24, 'Must be a valid IPv4 /24 CIDR').optional(),
    gateway: ipAddressSchema.optional(),
    vm_ip: ipAddressSchema.optional(),
    dhcp_start: ipAddressSchema.optional(),
    dhcp_end: ipAddressSchema.optional(),
    name: z.string().trim().min(1).optional(),
    zone: z.string().trim().min(1).optional(),
    bridge_name: z.string().trim().min(1).optional(),
    mac: z.string().trim().regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i, 'Must be a valid MAC address').optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const mode = value.mode || 'nat-auto';

    if (mode === 'nat-custom' && !value.subnet_prefix) {
      const requiredFields = ['cidr', 'gateway', 'vm_ip', 'dhcp_start', 'dhcp_end'];
      for (const field of requiredFields) {
        if (!value[field]) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `Required when network.mode is ${mode}`,
          });
        }
      }
    }

    if (mode === 'bridge' && value.subnet_prefix) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['subnet_prefix'],
        message: 'subnet_prefix is only valid for nat-custom networking',
      });
    }
  });

const configSchema = z
  .object({
    vm: vmSchema,
    paths: z
      .object({
        vm_data_dir: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
    image: z
      .object({
        url: z.string().url().optional(),
        os_variant: z.string().trim().min(1).optional(),
        name: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
    dns: z
      .object({
        resolvers: z.array(ipAddressSchema).min(1),
      })
      .strict()
      .optional(),
    network: networkSchema.optional(),
    packages: z.array(z.string().trim().min(1)).optional(),
    ports: z
      .array(
        z
          .object({
            host: portSchema,
            guest: portSchema,
            proto: z.enum(['tcp', 'udp']).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const createVmRequestSchema = z
  .object({
    config: configSchema,
    sshPublicKey: z.string().trim().min(1).optional(),
  })
  .strict();

export function parseCreateVmRequest(payload) {
  return createVmRequestSchema.parse(payload);
}

export function formatValidationError(error) {
  if (!(error instanceof ZodError)) {
    return null;
  }

  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

export function isValidationError(error) {
  return error instanceof ZodError;
}
