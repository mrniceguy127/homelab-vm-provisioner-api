import crypto from 'node:crypto';

import {
  listStoredNetworkGroups,
  listStoredUsers,
  listStoredVmDefinitions,
  upsertStoredNetworkGroup,
  upsertStoredUser,
  upsertStoredVmDefinition,
} from './db.js';

export const NETWORK_PROFILES = ['private', 'nat', 'isolated_nat', 'bridged'];
export const DEFAULT_NETWORK_POOL_CIDR = process.env.HLVMP_NETWORK_POOL_CIDR || '10.80.0.0/16';
export const DEFAULT_NETWORK_GROUP_PREFIX_LENGTH = Number.parseInt(
  process.env.HLVMP_NETWORK_GROUP_PREFIX_LENGTH || '28',
  10,
);
export const DEFAULT_ADMIN_USER_ID = 'user-admin';
export const DEFAULT_ADMIN_USERNAME = process.env.HLVMP_DEFAULT_ADMIN_USERNAME || 'admin';

/**
 * Convert an IPv4 address into a 32-bit unsigned integer.
 *
 * @param {string} address - IPv4 address.
 * @returns {number} Numeric IPv4 value.
 */
export function ipv4ToInt(address) {
  return address
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .reduce((value, octet) => ((value << 8) | octet) >>> 0, 0);
}

/**
 * Convert a 32-bit unsigned integer into an IPv4 string.
 *
 * @param {number} value - Numeric IPv4 value.
 * @returns {string} IPv4 address.
 */
export function intToIpv4(value) {
  return [24, 16, 8, 0]
    .map((shift) => String((value >>> shift) & 0xff))
    .join('.');
}

/**
 * Parse an IPv4 CIDR string.
 *
 * @param {string} cidr - IPv4 CIDR text.
 * @returns {{cidr:string,address:string,prefixLength:number,networkInt:number,broadcastInt:number,firstHostInt:number,lastHostInt:number}} Parsed network metadata.
 */
export function parseCidr(cidr) {
  const [address, prefixLengthText] = String(cidr || '').trim().split('/');
  const prefixLength = Number.parseInt(prefixLengthText, 10);
  if (!address || Number.isNaN(prefixLength) || prefixLength < 0 || prefixLength > 32) {
    throw new Error(`Invalid CIDR: ${cidr}`);
  }

  const mask = prefixLength === 0
    ? 0
    : ((0xffffffff << (32 - prefixLength)) >>> 0);
  const networkInt = ipv4ToInt(address) & mask;
  const broadcastInt = (networkInt | (~mask >>> 0)) >>> 0;

  return {
    cidr: `${intToIpv4(networkInt)}/${prefixLength}`,
    address: intToIpv4(networkInt),
    prefixLength,
    networkInt,
    broadcastInt,
    firstHostInt: prefixLength >= 31 ? networkInt : (networkInt + 1) >>> 0,
    lastHostInt: prefixLength >= 31 ? broadcastInt : (broadcastInt - 1) >>> 0,
  };
}

/**
 * Return whether two CIDRs overlap.
 *
 * @param {string} leftCidr - Left CIDR.
 * @param {string} rightCidr - Right CIDR.
 * @returns {boolean} True when the ranges overlap.
 */
export function cidrsOverlap(leftCidr, rightCidr) {
  const left = parseCidr(leftCidr);
  const right = parseCidr(rightCidr);
  return left.networkInt <= right.broadcastInt && right.networkInt <= left.broadcastInt;
}

/**
 * Return whether a CIDR contains an IPv4 address.
 *
 * @param {string} cidr - CIDR text.
 * @param {string} ipAddress - IPv4 address.
 * @returns {boolean} True when the address falls inside the CIDR.
 */
export function cidrContainsIp(cidr, ipAddress) {
  const network = parseCidr(cidr);
  const value = ipv4ToInt(ipAddress);
  return value >= network.networkInt && value <= network.broadcastInt;
}

/**
 * Validate CIDR format and ensure it's a proper network address.
 *
 * @param {string} cidr - CIDR to validate.
 * @throws {Error} If CIDR format is invalid or not a network address.
 */
export function validateCidrFormat(cidr) {
  if (!cidr || typeof cidr !== 'string') {
    throw new Error('Invalid CIDR format: CIDR must be a non-empty string');
  }

  const trimmed = cidr.trim();
  if (!trimmed.includes('/')) {
    throw new Error('Invalid CIDR format: Missing prefix length (e.g., /24)');
  }

  const [address, prefixLengthText] = trimmed.split('/');
  const parts = address.split('.');
  
  if (parts.length !== 4) {
    throw new Error('Invalid CIDR format: IPv4 address must have 4 octets');
  }

  for (const part of parts) {
    const octet = Number.parseInt(part, 10);
    if (Number.isNaN(octet) || octet < 0 || octet > 255) {
      throw new Error(`Invalid CIDR format: Invalid octet value '${part}'`);
    }
  }

  const prefixLength = Number.parseInt(prefixLengthText, 10);
  if (Number.isNaN(prefixLength) || prefixLength < 0 || prefixLength > 32) {
    throw new Error(`Invalid CIDR format: Prefix length must be 0-32, got '${prefixLengthText}'`);
  }

  // Ensure it's a network address (not a host address)
  const network = parseCidr(trimmed);
  if (network.address !== address) {
    throw new Error(
      `Invalid CIDR format: ${trimmed} must be a network address, did you mean ${network.cidr}?`
    );
  }
}

/**
 * Validate that CIDR subnet size is at most 8 IP addresses (/29 or smaller).
 *
 * @param {string} cidr - CIDR to validate.
 * @throws {Error} If subnet is larger than 8 IPs.
 */
export function validateCidrSize(cidr) {
  const network = parseCidr(cidr);
  const ipCount = (network.broadcastInt - network.networkInt + 1) >>> 0;
  
  if (ipCount > 8) {
    throw new Error(
      `Network group subnet must be at most 8 IP addresses (/29 or smaller). ` +
      `${cidr} contains ${ipCount} addresses. Try /29 (8 IPs), /30 (4 IPs), /31 (2 IPs), or /32 (1 IP).`
    );
  }
}

/**
 * Validate that CIDR is within the global network pool.
 *
 * @param {string} cidr - CIDR to validate.
 * @param {string} [poolCidr=DEFAULT_NETWORK_POOL_CIDR] - Global pool CIDR.
 * @throws {Error} If CIDR is outside the global pool.
 */
export function validateCidrWithinGlobalPool(cidr, poolCidr = DEFAULT_NETWORK_POOL_CIDR) {
  const network = parseCidr(cidr);
  const pool = parseCidr(poolCidr);
  
  const isWithinPool = 
    network.networkInt >= pool.networkInt && 
    network.broadcastInt <= pool.broadcastInt;
  
  if (!isWithinPool) {
    throw new Error(
      `Network group subnet must be within the global pool ${poolCidr}. ` +
      `${cidr} is outside this range.`
    );
  }
}

/**
 * Validate that CIDR does not overlap with existing network groups.
 *
 * @param {string} cidr - CIDR to validate.
 * @param {Array<{subnet_cidr:string,name:string}>} networkGroups - Existing network groups.
 * @throws {Error} If CIDR overlaps with an existing network group.
 */
export function validateCidrOverlap(cidr, networkGroups) {
  for (const group of networkGroups) {
    if (group.subnet_cidr && cidrsOverlap(cidr, group.subnet_cidr)) {
      throw new Error(
        `Network group subnet overlaps with existing network group '${group.name}' (${group.subnet_cidr})`
      );
    }
  }
}

/**
 * Perform all network group CIDR validations.
 *
 * @param {string} cidr - CIDR to validate.
 * @param {Array<{subnet_cidr:string,name:string}>} networkGroups - Existing network groups.
 * @param {string} [poolCidr=DEFAULT_NETWORK_POOL_CIDR] - Global pool CIDR.
 * @throws {Error} If any validation fails.
 */
export function validateNetworkGroupCidr(cidr, networkGroups, poolCidr = DEFAULT_NETWORK_POOL_CIDR) {
  validateCidrFormat(cidr);
  validateCidrSize(cidr);
  validateCidrWithinGlobalPool(cidr, poolCidr);
  validateCidrOverlap(cidr, networkGroups);
}

/**
 * Build default gateway and DHCP range values for a subnet.
 *
 * @param {string} subnetCidr - Allocated subnet.
 * @returns {{gatewayIp:string,dhcpStart:string,dhcpEnd:string}} Gateway and DHCP range.
 */
export function buildDhcpRange(subnetCidr) {
  const network = parseCidr(subnetCidr);
  if ((network.lastHostInt - network.firstHostInt) < 1) {
    throw new Error(`Subnet does not have enough host capacity: ${subnetCidr}`);
  }

  return {
    gatewayIp: intToIpv4(network.firstHostInt),
    dhcpStart: intToIpv4((network.firstHostInt + 1) >>> 0),
    dhcpEnd: intToIpv4(network.lastHostInt),
  };
}

/**
 * Allocate the first available non-overlapping subnet from the global pool.
 *
 * @param {Array<{subnet_cidr:string}>} networkGroups - Existing groups.
 * @param {string} [poolCidr=DEFAULT_NETWORK_POOL_CIDR] - Global address pool.
 * @param {number} [prefixLength=DEFAULT_NETWORK_GROUP_PREFIX_LENGTH] - Per-group prefix length.
 * @returns {string} Allocated subnet CIDR.
 */
export function allocateSubnetFromPool(
  networkGroups,
  poolCidr = DEFAULT_NETWORK_POOL_CIDR,
  prefixLength = DEFAULT_NETWORK_GROUP_PREFIX_LENGTH,
) {
  const pool = parseCidr(poolCidr);
  if (prefixLength < pool.prefixLength || prefixLength > 30) {
    throw new Error(`Invalid network-group prefix length ${prefixLength} for pool ${poolCidr}.`);
  }

  const subnetSize = 2 ** (32 - prefixLength);
  for (
    let candidate = pool.networkInt;
    (candidate + subnetSize - 1) <= pool.broadcastInt;
    candidate = (candidate + subnetSize) >>> 0
  ) {
    const candidateCidr = `${intToIpv4(candidate)}/${prefixLength}`;
    const overlaps = networkGroups.some((group) => group.subnet_cidr && cidrsOverlap(group.subnet_cidr, candidateCidr));
    if (!overlaps) {
      return candidateCidr;
    }
  }

  throw new Error(`No free /${prefixLength} subnet remains inside ${poolCidr}.`);
}

/**
 * Generate a deterministic bridge interface name from a network-group id.
 *
 * @param {string} networkGroupId - Network-group identifier.
 * @returns {string} Linux bridge interface name.
 */
export function buildBridgeName(networkGroupId) {
  const suffix = crypto.createHash('sha1').update(networkGroupId).digest('hex').slice(0, 8);
  return `hvpb${suffix}`;
}

/**
 * Generate a libvirt network name from owner and group identifiers.
 *
 * @param {string} ownerUserId - Owning user id.
 * @param {string} groupName - Human-readable group name.
 * @param {string} networkGroupId - Network-group identifier.
 * @returns {string} Libvirt network name.
 */
export function buildLibvirtNetworkName(ownerUserId, groupName, networkGroupId) {
  const slug = String(groupName || 'group')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'group';
  const suffix = crypto.createHash('sha1').update(`${ownerUserId}:${networkGroupId}`).digest('hex').slice(0, 6);
  return `hvp-ng-${slug}-${suffix}`;
}

/**
 * Load one VM state record when present (legacy stub).
 * API uses database for state, not files.
 *
 * @param {string} _vmName - VM name (unused).
 * @returns {Promise<object>} Empty object.
 */
export async function loadVmStateRecord(_vmName) {
  return {};
}

/**
 * List persisted tenant records.
 *
 * @returns {Promise<object[]>} Known users.
 */
export async function listUsers() {
  // API only uses database - no legacy file migration
  return await listStoredUsers();
}

/**
 * Ensure the default admin tenant exists.
 *
 * @returns {Promise<object>} Default admin user.
 */
export async function ensureDefaultUser() {
  const users = await listUsers();
  const existing = users.find((user) => user.id === DEFAULT_ADMIN_USER_ID);
  if (existing) {
    return existing;
  }

  const nextUser = {
    id: DEFAULT_ADMIN_USER_ID,
    username: DEFAULT_ADMIN_USERNAME,
    role: 'admin',
    created_at: new Date().toISOString(),
  };
  return upsertStoredUser(nextUser);
}

/**
 * List persisted network-group records.
 *
 * @returns {Promise<object[]>} Known network groups.
 */
export async function listNetworkGroups() {
  // API only uses database - no legacy file migration
  return await listStoredNetworkGroups();
}

function networkGroupSignature(group) {
  if (group.profile === 'bridged') {
    return `bridged:${group.bridge_name || ''}`;
  }
  return `${group.profile}:${group.subnet_cidr}`;
}

function normalizeProfile(profile) {
  const rawProfile = String(profile || 'isolated_nat').trim();
  if (!NETWORK_PROFILES.includes(rawProfile)) {
    throw new Error(`Unsupported network-group profile: ${profile}`);
  }
  return rawProfile;
}

function buildNetworkGroupRecord({ ownerUserId, name, profile, subnetCidr, bridgeName, libvirtNetworkName, gatewayIp, dhcpStart, dhcpEnd }) {
  const id = `ng-${crypto.randomBytes(4).toString('hex')}`;
  const normalizedProfile = normalizeProfile(profile);
  const effectiveSubnet = normalizedProfile === 'bridged' ? null : (subnetCidr || DEFAULT_NETWORK_POOL_CIDR);
  const dhcpRange = normalizedProfile === 'bridged'
    ? { gatewayIp: gatewayIp || null, dhcpStart: dhcpStart || null, dhcpEnd: dhcpEnd || null }
    : (gatewayIp && dhcpStart && dhcpEnd)
      ? { gatewayIp, dhcpStart, dhcpEnd }
      : buildDhcpRange(effectiveSubnet);

  return {
    id,
    owner_user_id: ownerUserId,
    name,
    libvirt_network_name: libvirtNetworkName || buildLibvirtNetworkName(ownerUserId, name, id),
    bridge_name: bridgeName || buildBridgeName(id),
    subnet_cidr: effectiveSubnet,
    gateway_ip: dhcpRange.gatewayIp,
    dhcp_start: dhcpRange.dhcpStart,
    dhcp_end: dhcpRange.dhcpEnd,
    profile: normalizedProfile,
    created_at: new Date().toISOString(),
  };
}

async function saveNetworkGroups(networkGroups) {
  await Promise.all(networkGroups.map((networkGroup) => upsertStoredNetworkGroup(networkGroup)));
}

/**
 * Create and persist a network-group record.
 *
 * @param {{ownerUserId:string,name:string,profile?:string,subnetCidr?:string,bridgeName?:string,libvirtNetworkName?:string,gatewayIp?:string,dhcpStart?:string,dhcpEnd?:string}} input - Network-group input.
 * @returns {Promise<object>} Created group.
 */
export async function createNetworkGroup(input) {
  const ownerUserId = String(input.ownerUserId || '').trim();
  const name = String(input.name || '').trim();
  const profile = normalizeProfile(input.profile || 'isolated_nat');
  if (!ownerUserId || !name) {
    throw new Error('ownerUserId and name are required to create a network group.');
  }

  const [users, networkGroups] = await Promise.all([listUsers(), listNetworkGroups()]);
  if (!users.some((user) => user.id === ownerUserId)) {
    throw new Error(`Unknown owner user: ${ownerUserId}`);
  }
  if (networkGroups.some((group) => group.owner_user_id === ownerUserId && group.name === name)) {
    throw new Error(`Network group already exists for ${ownerUserId}: ${name}`);
  }

  const subnetCidr = profile === 'bridged'
    ? null
    : (input.subnetCidr || allocateSubnetFromPool(networkGroups));
  
  // Validate custom subnet CIDRs
  if (subnetCidr && input.subnetCidr) {
    validateNetworkGroupCidr(subnetCidr, networkGroups);
  }
  
  // Legacy overlap check for auto-allocated subnets (already validated above for custom)
  if (subnetCidr && !input.subnetCidr) {
    for (const group of networkGroups) {
      if (group.subnet_cidr && cidrsOverlap(group.subnet_cidr, subnetCidr)) {
        throw new Error(`Network-group subnet overlaps an existing allocation: ${subnetCidr}`);
      }
    }
  }

  const nextGroup = buildNetworkGroupRecord({
    ownerUserId,
    name,
    profile,
    subnetCidr,
    bridgeName: input.bridgeName,
    libvirtNetworkName: input.libvirtNetworkName,
    gatewayIp: input.gatewayIp,
    dhcpStart: input.dhcpStart,
    dhcpEnd: input.dhcpEnd,
  });
  await saveNetworkGroups([...networkGroups, nextGroup]);
  return nextGroup;
}

async function ensureDefaultNetworkGroup(ownerUserId) {
  const groups = await listNetworkGroups();
  const existing = groups.find((group) => group.owner_user_id === ownerUserId && group.name === 'default-admin');
  if (existing) {
    return existing;
  }

  return createNetworkGroup({
    ownerUserId,
    name: 'default-admin',
    profile: 'isolated_nat',
  });
}

function normalizeLegacyProfile(network) {
  const mode = String(network?.mode || '').trim().toLowerCase();
  if (mode === 'bridge' || mode === 'bridged') {
    return 'bridged';
  }
  if (mode === 'private') {
    return 'private';
  }
  return 'isolated_nat';
}

async function findOrCreateImportedNetworkGroup(networkGroups, ownerUserId, vmName, legacyNetwork) {
  const profile = normalizeLegacyProfile(legacyNetwork);
  const importedSeed = {
    owner_user_id: ownerUserId,
    profile,
    subnet_cidr: legacyNetwork?.subnet_cidr || legacyNetwork?.cidr || null,
    bridge_name: legacyNetwork?.bridge_name || null,
  };
  const existing = networkGroups.find((group) => networkGroupSignature(group) === networkGroupSignature(importedSeed));
  if (existing) {
    return existing;
  }

  if (profile !== 'bridged' && !importedSeed.subnet_cidr) {
    return ensureDefaultNetworkGroup(ownerUserId);
  }

  const importedGroup = await createNetworkGroup({
    ownerUserId,
    name: networkGroups.some((group) => group.name === 'default-admin') ? `${vmName}-legacy` : 'default-admin',
    profile,
    subnetCidr: importedSeed.subnet_cidr,
    bridgeName: importedSeed.bridge_name,
    libvirtNetworkName: legacyNetwork?.libvirt_network_name || legacyNetwork?.name,
    gatewayIp: legacyNetwork?.gateway_ip || legacyNetwork?.gateway,
    dhcpStart: legacyNetwork?.dhcp_start,
    dhcpEnd: legacyNetwork?.dhcp_end,
  });
  networkGroups.push(importedGroup);
  return importedGroup;
}

function isMacAddress(value) {
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(String(value || '').trim());
}

/**
 * Generate a unique libvirt-friendly MAC address.
 *
 * @param {Set<string>} usedMacAddresses - Already assigned MAC addresses.
 * @param {string} [preferredValue] - Optional preferred MAC.
 * @returns {string} Assigned MAC address.
 */
export function generateMacAddress(usedMacAddresses, preferredValue = '') {
  const normalizedPreferredValue = String(preferredValue || '').trim().toLowerCase();
  if (isMacAddress(normalizedPreferredValue) && !usedMacAddresses.has(normalizedPreferredValue)) {
    usedMacAddresses.add(normalizedPreferredValue);
    return normalizedPreferredValue;
  }

  for (let attempt = 0; attempt < 4096; attempt += 1) {
    const candidate = [0x52, 0x54, 0x00, ...crypto.randomBytes(3)]
      .map((octet) => octet.toString(16).padStart(2, '0'))
      .join(':');
    if (!usedMacAddresses.has(candidate)) {
      usedMacAddresses.add(candidate);
      return candidate;
    }
  }

  throw new Error('Unable to generate a unique MAC address.');
}

/**
 * Allocate a free VM IP inside a network-group subnet.
 *
 * @param {object} networkGroup - Target network group.
 * @param {Set<string>} usedIpAddresses - Already assigned IPs.
 * @param {string} [preferredValue] - Optional preferred IP.
 * @returns {string|null} Assigned IP, or null for bridged groups.
 */
export function allocateVmIpFromGroup(networkGroup, usedIpAddresses, preferredValue = '') {
  if (!networkGroup.subnet_cidr) {
    return null;
  }

  const normalizedPreferredValue = String(preferredValue || '').trim();
  if (
    normalizedPreferredValue
    && cidrContainsIp(networkGroup.subnet_cidr, normalizedPreferredValue)
    && !usedIpAddresses.has(normalizedPreferredValue)
    && normalizedPreferredValue !== networkGroup.gateway_ip
  ) {
    usedIpAddresses.add(normalizedPreferredValue);
    return normalizedPreferredValue;
  }

  const startValue = ipv4ToInt(networkGroup.dhcp_start);
  const endValue = ipv4ToInt(networkGroup.dhcp_end);
  for (let candidate = startValue; candidate <= endValue; candidate += 1) {
    const ipAddress = intToIpv4(candidate >>> 0);
    if (!usedIpAddresses.has(ipAddress) && ipAddress !== networkGroup.gateway_ip) {
      usedIpAddresses.add(ipAddress);
      return ipAddress;
    }
  }

  throw new Error(`Network group ${networkGroup.name} is out of assignable IP addresses.`);
}

function normalizePortForwards(ports, vmName, ownerUserId, vmIpAddress) {
  return (ports || []).map((port, index) => {
    const protocol = String(port.proto || port.protocol || 'tcp').trim().toLowerCase() || 'tcp';
    const externalPort = Number.parseInt(String(port.external_port ?? port.host), 10);
    const internalPort = Number.parseInt(String(port.internal_port ?? port.guest), 10);
    return {
      id: port.id || `pf-${vmName}-${protocol}-${externalPort}-${internalPort}-${index + 1}`,
      owner_user_id: port.owner_user_id || ownerUserId,
      vm_id: port.vm_id || vmName,
      protocol,
      proto: protocol,
      external_port: externalPort,
      internal_port: internalPort,
      internal_ip: port.internal_ip || vmIpAddress,
      description: String(port.description || '').trim(),
      enabled: port.enabled !== false,
      host: externalPort,
      guest: internalPort,
    };
  });
}

/**
 * Build the managed network config embedded into a VM definition.
 *
 * Each saved VM config carries a copy of its resolved network-group identity so
 * the Python provisioner can reconcile libvirt and managed nftables policy without a JS-side
 * database.
 *
 * @param {object} networkGroup - Network-group record.
 * @param {{ownerUserId:string,vmIpAddress:string|null,macAddress:string}} identity - VM identity fields.
 * @returns {object} Managed network config payload.
 */
export function buildManagedNetworkConfig(networkGroup, identity) {
  return {
    profile: networkGroup.profile,
    mode: networkGroup.profile === 'bridged' ? 'bridge' : networkGroup.profile,
    network_group_id: networkGroup.id,
    group_name: networkGroup.name,
    owner_user_id: networkGroup.owner_user_id,
    libvirt_network_name: networkGroup.libvirt_network_name,
    name: networkGroup.libvirt_network_name,
    bridge_name: networkGroup.bridge_name,
    subnet_cidr: networkGroup.subnet_cidr,
    cidr: networkGroup.subnet_cidr,
    gateway_ip: networkGroup.gateway_ip,
    gateway: networkGroup.gateway_ip,
    dhcp_start: networkGroup.dhcp_start,
    dhcp_end: networkGroup.dhcp_end,
    vm_ip: identity.vmIpAddress,
    mac: identity.macAddress,
  };
}

/**
 * Initialize users, network groups, and migrated VM networking metadata.
 *
 * The migration treats the existing single-admin deployment as the initial
 * tenant while preserving any previously assigned VM MAC/IP identity when that
 * identity can be mapped onto a managed group.
 *
 * @returns {Promise<void>} Resolves after metadata and configs are normalized.
 */
export async function initializeNetworkModel() {
  const defaultUser = await ensureDefaultUser();
  const storedVmDefs = await listStoredVmDefinitions();
  let networkGroups = await listNetworkGroups();

  if (storedVmDefs.length === 0 && networkGroups.length === 0) {
    await ensureDefaultNetworkGroup(defaultUser.id);
    return;
  }

  const usedMacAddresses = new Set();
  const usedIpAddresses = new Set();

  for (const vmDef of storedVmDefs) {
    const entry = { vmName: vmDef.vm_name, config: vmDef.config };
    const state = await loadVmStateRecord(entry.vmName);
    const ownerUserId = String(entry.config?.vm?.owner_user_id || DEFAULT_ADMIN_USER_ID).trim() || DEFAULT_ADMIN_USER_ID;
    let networkGroup = networkGroups.find((group) => group.id === entry.config?.vm?.network_group_id);
    if (!networkGroup) {
      networkGroup = await findOrCreateImportedNetworkGroup(
        networkGroups,
        ownerUserId,
        entry.vmName,
        state.network || entry.config.network || {},
      );
      networkGroups = await listNetworkGroups();
    }

    const preferredMac = entry.config?.vm?.mac_address || entry.config?.network?.mac || state?.network?.mac;
    const preferredIp = entry.config?.vm?.ip_address || entry.config?.network?.vm_ip || state?.network?.vm_ip;
    const macAddress = generateMacAddress(usedMacAddresses, preferredMac);
    const vmIpAddress = allocateVmIpFromGroup(networkGroup, usedIpAddresses, preferredIp);

    const nextConfig = JSON.parse(JSON.stringify(entry.config || {}));
    nextConfig.vm = {
      ...(nextConfig.vm || {}),
      owner_user_id: ownerUserId,
      network_group_id: networkGroup.id,
      mac_address: macAddress,
      ip_address: vmIpAddress,
      allow_same_group_traffic: nextConfig.vm?.allow_same_group_traffic !== false,
      allow_host_access: nextConfig.vm?.allow_host_access !== false,
      allow_private_lan_access: Boolean(nextConfig.vm?.allow_private_lan_access),
      internet_access: networkGroup.profile === 'private'
        ? false
        : nextConfig.vm?.internet_access !== false,
    };
    nextConfig.network = buildManagedNetworkConfig(networkGroup, {
      ownerUserId,
      vmIpAddress,
      macAddress,
    });

    if (nextConfig.ports?.length) {
      nextConfig.ports = normalizePortForwards(nextConfig.ports, entry.vmName, ownerUserId, vmIpAddress);
    }

    await upsertStoredVmDefinition({
      vm_name: entry.vmName,
      owner_user_id: ownerUserId,
      network_group_id: networkGroup.id,
      target_host_id: process.env.HOST_ID || 'local',
      config: nextConfig,
    });
  }

  if ((await listNetworkGroups()).length === 0) {
    await ensureDefaultNetworkGroup(defaultUser.id);
  }
}

/**
 * Prepare a VM config payload for persistence under the tenant/group model.
 *
 * @param {{config: object, sshPublicKey?: string, setupScript?: string}} payload - Raw request payload.
 * @param {{existingVmName?: string}} [options={}] - Save-time options.
 * @returns {Promise<{config: object, sshPublicKey?: string, setupScript?: string}>} Prepared payload.
 */
export async function prepareVmConfigForSave(payload, options = {}) {
  const { existingVmName = '' } = options;
  const defaultUser = await ensureDefaultUser();
  let networkGroups = await listNetworkGroups();
  if (networkGroups.length === 0) {
    await ensureDefaultNetworkGroup(defaultUser.id);
    networkGroups = await listNetworkGroups();
  }

  const nextPayload = JSON.parse(JSON.stringify(payload || {}));
  const nextConfig = nextPayload.config || {};
  const vm = nextConfig.vm || {};
  const ownerUserId = String(vm.owner_user_id || DEFAULT_ADMIN_USER_ID).trim() || DEFAULT_ADMIN_USER_ID;
  let networkGroupId = String(vm.network_group_id || nextConfig.network?.network_group_id || '').trim();
  if (!networkGroupId) {
    networkGroupId = (await ensureDefaultNetworkGroup(ownerUserId)).id;
    networkGroups = await listNetworkGroups();
  }

  const ownerUsers = await listUsers();
  const ownerUser = ownerUsers.find((user) => user.id === ownerUserId);
  if (!ownerUser) {
    throw new Error(`Unknown owner user: ${ownerUserId}`);
  }

  const networkGroup = networkGroups.find((group) => group.id === networkGroupId);
  if (!networkGroup) {
    throw new Error(`Unknown network group: ${networkGroupId}`);
  }
  if (networkGroup.owner_user_id !== ownerUserId) {
    throw new Error(`Network group ${networkGroupId} is owned by a different user.`);
  }
  if (vm.allow_private_lan_access && ownerUser.role !== 'admin') {
    throw new Error('allow_private_lan_access is currently restricted to admin-owned VMs.');
  }

  const storedVmDefs = await listStoredVmDefinitions();
  const currentVmName = String(vm.name || '').trim();
  const usedMacAddresses = new Set();
  const usedIpAddresses = new Set();
  for (const vmDef of storedVmDefs) {
    const entry = { vmName: vmDef.vm_name, config: vmDef.config };
    if (entry.vmName === existingVmName || entry.vmName === currentVmName) {
      continue;
    }

    if (entry.config?.vm?.mac_address) {
      usedMacAddresses.add(String(entry.config.vm.mac_address).trim().toLowerCase());
    }
    if (entry.config?.vm?.ip_address) {
      usedIpAddresses.add(String(entry.config.vm.ip_address).trim());
    }
  }

  const macAddress = generateMacAddress(
    usedMacAddresses,
    vm.mac_address || nextConfig.network?.mac,
  );
  const vmIpAddress = allocateVmIpFromGroup(
    networkGroup,
    usedIpAddresses,
    vm.ip_address || nextConfig.network?.vm_ip,
  );

  nextConfig.vm = {
    ...vm,
    owner_user_id: ownerUserId,
    network_group_id: networkGroup.id,
    mac_address: macAddress,
    ip_address: vmIpAddress,
    allow_same_group_traffic: vm.allow_same_group_traffic !== false,
    allow_host_access: vm.allow_host_access !== false,
    allow_private_lan_access: Boolean(vm.allow_private_lan_access),
    internet_access: networkGroup.profile === 'private' ? false : vm.internet_access !== false,
  };
  nextConfig.network = buildManagedNetworkConfig(networkGroup, {
    ownerUserId,
    vmIpAddress,
    macAddress,
  });

  if (nextConfig.ports?.length) {
    nextConfig.ports = normalizePortForwards(nextConfig.ports, nextConfig.vm.name, ownerUserId, vmIpAddress);
  }

  nextPayload.config = nextConfig;
  return nextPayload;
}
