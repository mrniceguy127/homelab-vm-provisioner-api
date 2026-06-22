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

function isIpv4Cidr(value) {
  const [address, prefixLengthText] = value.split('/');
  const prefixLength = Number.parseInt(prefixLengthText, 10);
  return isIpv4Address(address) && !Number.isNaN(prefixLength) && prefixLength >= 0 && prefixLength <= 32;
}

const ipAddressSchema = z.string().trim().refine(isIpAddress, 'Must be a valid IP address');

const portSchema = z
  .number()
  .int()
  .min(1, 'Must be between 1 and 65535')
  .max(65535, 'Must be between 1 and 65535');

const vmSchema = z
  .object({
    name: z.string().trim().min(1).max(63, 'VM names must be 63 characters or fewer'),
    user: z.string().trim().min(1),
    owner_user_id: z.string().trim().min(1).optional(),
    network_group_id: z.string().trim().min(1).optional(),
    ssh_key_file: z.string().trim().min(1).optional(),
    ram_mb: z.number().int().positive(),
    vcpus: z.number().int().positive(),
    disk_gb: z.number().int().positive(),
    allow_sudo: z.boolean().optional(),
    allow_same_group_traffic: z.boolean().optional(),
    allow_host_access: z.boolean().optional(),
    allow_private_lan_access: z.boolean().optional(),
    internet_access: z.boolean().optional(),
    mac_address: z.string().trim().regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i, 'Must be a valid MAC address').optional(),
    ip_address: ipAddressSchema.optional(),
    trust: z.enum(['trusted', 'untrusted']).optional(),
    template: z.string().trim().min(1).optional(),
  })
  .strict();

const networkSchema = z
  .object({
    mode: z.enum(['nat-auto', 'nat-custom', 'bridge', 'private', 'nat', 'isolated_nat', 'bridged']).optional(),
    profile: z.enum(['private', 'nat', 'isolated_nat', 'bridged']).optional(),
    network_group_id: z.string().trim().min(1).optional(),
    group_name: z.string().trim().min(1).optional(),
    owner_user_id: z.string().trim().min(1).optional(),
    libvirt_network_name: z.string().trim().min(1).optional(),
    subnet_prefix: z.string().trim().refine(isIpv4Prefix, 'Must look like 192.168.240').optional(),
    subnet_cidr: z.string().trim().refine(isIpv4Cidr, 'Must be a valid IPv4 CIDR').optional(),
    cidr: z.string().trim().refine(isIpv4Cidr, 'Must be a valid IPv4 CIDR').optional(),
    gateway: ipAddressSchema.optional(),
    gateway_ip: ipAddressSchema.optional(),
    vm_ip: ipAddressSchema.optional(),
    dhcp_start: ipAddressSchema.optional(),
    dhcp_end: ipAddressSchema.optional(),
    name: z.string().trim().min(1).optional(),
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
    scripts: z
      .object({
        setup_script_file: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
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
            id: z.string().trim().min(1).optional(),
            owner_user_id: z.string().trim().min(1).optional(),
            vm_id: z.string().trim().min(1).optional(),
            host: portSchema,
            guest: portSchema,
            external_port: portSchema.optional(),
            internal_port: portSchema.optional(),
            internal_ip: ipAddressSchema.optional(),
            proto: z.enum(['tcp', 'udp']).optional(),
            protocol: z.enum(['tcp', 'udp']).optional(),
            description: z.string().trim().optional(),
            enabled: z.boolean().optional(),
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
    setupScript: z.string().trim().min(1).optional(),
  })
  .strict();

const networkGroupRequestSchema = z
  .object({
    ownerUserId: z.string().trim().min(1),
    name: z.string().trim().min(1),
    profile: z.enum(['private', 'nat', 'isolated_nat', 'bridged']).optional(),
    subnetCidr: z.string().trim().refine(isIpv4Cidr, 'Must be a valid IPv4 CIDR').optional(),
    bridgeName: z.string().trim().min(1).optional(),
  })
  .strict();

const vmPolicyRequestSchema = z
  .object({
    allow_same_group_traffic: z.boolean().optional(),
    allow_host_access: z.boolean().optional(),
    allow_private_lan_access: z.boolean().optional(),
    internet_access: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one policy field is required');

export function parseCreateVmRequest(payload) {
  return createVmRequestSchema.parse(payload);
}

export function parseNetworkGroupRequest(payload) {
  return networkGroupRequestSchema.parse(payload);
}

export function parseVmPolicyRequest(payload) {
  return vmPolicyRequestSchema.parse(payload);
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
