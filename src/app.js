import express from 'express';

import {
  configPathForVm,
  deleteSavedConfigArtifacts,
  listStoredConfigNames,
  loadStoredConfig,
  saveVmConfig,
} from './config-store.js';
import { getRepository, isDatabaseAvailable } from './db.js';
import {
  createNetworkGroup,
  listNetworkGroups,
  listUsers,
  prepareVmConfigForSave,
} from './network-model.js';
import {
  cloneVm,
  createVm,
  createVmSnapshot,
  deleteVmSnapshot,
  destroyVm,
  inspectVm,
  listHostVmNames,
  readVmLog,
  reconcileVmNetworking,
  restoreVmSnapshot,
  startVm,
  stopVm,
  streamVmLog,
} from './provisioner.js';
import {
  formatValidationError,
  isValidationError,
  parseCreateVmRequest,
  parseNetworkGroupRequest,
  parseVmPolicyRequest,
} from './validation.js';

const defaultDependencies = {
  configPathForVm,
  deleteSavedConfigArtifacts,
  createNetworkGroup,
  listStoredConfigNames,
  listNetworkGroups,
  listUsers,
  loadStoredConfig,
  prepareVmConfigForSave,
  saveVmConfig,
  cloneVm,
  createVm,
  createVmSnapshot,
  deleteVmSnapshot,
  destroyVm,
  inspectVm,
  listHostVmNames,
  readVmLog,
  reconcileVmNetworking,
  restoreVmSnapshot,
  startVm,
  stopVm,
  streamVmLog,
  parseCreateVmRequest,
  parseNetworkGroupRequest,
  parseVmPolicyRequest,
  formatValidationError,
  isValidationError,
  getRepository,
  isDatabaseAvailable,
};

/**
 * Create an HTTP 409 conflict error.
 *
 * @param {string} message - Human-readable error message.
 * @returns {Error} Error tagged with an HTTP status code.
 */
export function createConflictError(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

/**
 * Normalize a VM name for case-insensitive comparisons.
 *
 * @param {string} vmName - Raw VM name.
 * @returns {string} Lower-cased trimmed VM name.
 */
export function normalizeVmName(vmName) {
  return String(vmName || '').trim().toLowerCase();
}

/**
 * Ensure a VM name is unique across saved configs and host libvirt VMs.
 *
 * @param {object} deps - Dependency bag for config and VM lookups.
 * @param {Function} deps.listStoredConfigNames - Returns saved config names.
 * @param {Function} deps.listHostVmNames - Returns host libvirt VM names.
 * @param {string} vmName - Candidate VM name.
 * @returns {Promise<void>} Resolves when the name is available.
 * @throws {Error} Throws an HTTP 409 conflict when the name is already used.
 */
export async function assertVmNameIsAvailable(deps, vmName) {
  const normalizedVmName = normalizeVmName(vmName);
  const [storedConfigNames, hostVmNames] = await Promise.all([
    deps.listStoredConfigNames(),
    deps.listHostVmNames(),
  ]);

  if (storedConfigNames.some((name) => normalizeVmName(name) === normalizedVmName)) {
    throw createConflictError(`VM name is already in use by a saved config: ${vmName}`);
  }

  if (hostVmNames.some((name) => normalizeVmName(name) === normalizedVmName)) {
    throw createConflictError(`VM name is already in use by a libvirt VM on this host: ${vmName}`);
  }
}

/**
 * Inspect one configured VM and preserve configuration-first filtering.
 *
 * @param {object} deps - Dependency bag for VM inspection.
 * @param {Function} deps.inspectVm - Returns live VM details.
 * @param {Function} deps.configPathForVm - Resolves saved config paths.
 * @param {string} vmName - Configured VM name.
 * @returns {Promise<object>} VM details merged with configuration metadata.
 */
export async function inspectConfiguredVm(deps, vmName) {
  const storedConfig = await deps.loadStoredConfig(vmName);
  const storedVm = storedConfig.config?.vm || {};
  const storedNetwork = storedConfig.config?.network || {};

  try {
    const vm = await deps.inspectVm(vmName);
    return {
      ...vm,
      owner_user_id: vm.owner_user_id || storedVm.owner_user_id || null,
      network_group_id: vm.network_group_id || storedVm.network_group_id || null,
      allow_same_group_traffic: vm.allow_same_group_traffic ?? storedVm.allow_same_group_traffic ?? true,
      allow_host_access: vm.allow_host_access ?? storedVm.allow_host_access ?? true,
      allow_private_lan_access: vm.allow_private_lan_access ?? storedVm.allow_private_lan_access ?? false,
      internet_access: vm.internet_access ?? storedVm.internet_access ?? true,
      mac_address: vm.mac_address || storedVm.mac_address || storedNetwork.mac || null,
      ip_address: vm.ip_address || storedVm.ip_address || storedNetwork.vm_ip || vm.ip_address || null,
      network: {
        ...storedNetwork,
        ...(vm.network || {}),
      },
      ports: vm.ports?.length ? vm.ports : (storedConfig.config?.ports || []),
      configured: true,
      storedConfigPath: storedConfig.configPath,
      storedConfig: storedConfig.config,
    };
  } catch (error) {
    return {
      name: vmName,
      exists: false,
      status: 'unknown',
        owner_user_id: storedVm.owner_user_id || null,
        network_group_id: storedVm.network_group_id || null,
        allow_same_group_traffic: storedVm.allow_same_group_traffic ?? true,
        allow_host_access: storedVm.allow_host_access ?? true,
        allow_private_lan_access: storedVm.allow_private_lan_access ?? false,
        internet_access: storedVm.internet_access ?? true,
      mac_address: storedVm.mac_address || storedNetwork.mac || null,
      ip_address: storedVm.ip_address || storedNetwork.vm_ip || null,
      network: Object.keys(storedNetwork).length > 0 ? storedNetwork : null,
      ports: storedConfig.config?.ports || [],
      configured: true,
      storedConfigPath: storedConfig.configPath,
      storedConfig: storedConfig.config,
      provisionerError: error?.message || 'Unable to query provisioner state',
    };
  }
}

/**
 * Load a saved config or fail the request.
 *
 * @param {object} deps - Dependency bag for config loading.
 * @param {Function} deps.loadStoredConfig - Loads one stored config.
 * @param {string} vmName - VM name used as the saved config key.
 * @returns {Promise<object>} Stored config payload.
 */
export async function requireStoredConfig(deps, vmName) {
  return deps.loadStoredConfig(vmName);
}

/**
 * Wrap an async route handler for Express.
 *
 * @param {Function} handler - Async request handler.
 * @returns {Function} Express middleware that forwards rejections to `next()`.
 */
export function asyncRoute(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

/**
 * Parse a numeric line-count query parameter.
 *
 * @param {string|undefined} rawValue - Raw query-string value.
 * @param {number} fallback - Fallback count when the value is omitted.
 * @returns {number} Parsed line count.
 * @throws {Error} Throws an HTTP 400 error for invalid line counts.
 */
export function parseLines(rawValue, fallback) {
  if (rawValue === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsed) || parsed < 1 || parsed > 5000) {
    const error = new Error('lines must be an integer between 1 and 5000');
    error.statusCode = 400;
    throw error;
  }

  return parsed;
}

/**
 * Create the Express application with injectable dependencies.
 *
 * @param {object} [deps=defaultDependencies] - Overridable implementation dependencies.
 * @returns {import('express').Express} Configured Express application.
 */
export function createApp(deps = defaultDependencies) {
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_request, response) => {
    response.json({ ok: true });
  });

  app.get(
    '/api/users',
    asyncRoute(async (_request, response) => {
      response.json({ users: await deps.listUsers() });
    }),
  );

  app.get(
    '/api/network-groups',
    asyncRoute(async (_request, response) => {
      response.json({ networkGroups: await deps.listNetworkGroups() });
    }),
  );

  app.post(
    '/api/network-groups',
    asyncRoute(async (request, response) => {
      const payload = deps.parseNetworkGroupRequest(request.body);
      const networkGroup = await deps.createNetworkGroup(payload);
      response.status(201).json({ networkGroup });
    }),
  );

  app.post(
    '/api/vms/configs',
    asyncRoute(async (request, response) => {
      const payload = await deps.prepareVmConfigForSave(deps.parseCreateVmRequest(request.body));
      await assertVmNameIsAvailable(deps, payload.config.vm.name);
      const savedConfig = await deps.saveVmConfig(payload);

      response.status(201).json(savedConfig);
    }),
  );

  app.post(
    '/api/vms',
    asyncRoute(async (request, response) => {
      const payload = await deps.prepareVmConfigForSave(deps.parseCreateVmRequest(request.body));
      await assertVmNameIsAvailable(deps, payload.config.vm.name);
      const savedConfig = await deps.saveVmConfig(payload);
      let provisioned;
      try {
        provisioned = await deps.createVm(savedConfig.configPath);
      } catch (error) {
        try {
          await deps.deleteSavedConfigArtifacts(savedConfig);
        } catch (cleanupError) {
          console.error(cleanupError.message || cleanupError);
        }
        throw error;
      }

      response.status(201).json({
        ...savedConfig,
        provisioned,
      });
    }),
  );

  app.post(
    '/api/vms/:name/provision',
    asyncRoute(async (request, response) => {
      const storedConfig = await requireStoredConfig(deps, request.params.name);
      if (normalizeVmName(storedConfig.config?.vm?.name) !== normalizeVmName(request.params.name)) {
        throw createConflictError(`Stored config name mismatch for VM: ${request.params.name}`);
      }

      const vm = await deps.inspectVm(request.params.name).catch((error) => {
        if (error?.statusCode === 404) {
          return null;
        }

        throw error;
      });

      if (vm?.exists) {
        throw createConflictError(`VM name is already in use by a live VM: ${request.params.name}`);
      }

      const provisioned = await deps.createVm(storedConfig.configPath);
      response.status(201).json({
        name: request.params.name,
        configPath: storedConfig.configPath,
        provisioned,
      });
    }),
  );

  app.get(
    '/api/vms',
    asyncRoute(async (_request, response) => {
      const storedConfigNames = await deps.listStoredConfigNames();
      const vms = await Promise.all(storedConfigNames.map((name) => inspectConfiguredVm(deps, name)));

      response.json({
        vms: vms.sort((left, right) => left.name.localeCompare(right.name)),
      });
    }),
  );

  app.get(
    '/api/vms/:name',
    asyncRoute(async (request, response) => {
      const storedConfig = await requireStoredConfig(deps, request.params.name);
      const vmResult = await deps.inspectVm(request.params.name).catch((error) => ({
        name: request.params.name,
        exists: false,
        status: 'unknown',
        provisionerError: error?.message || 'Unable to query provisioner state',
      }));

      response.json({
        vm: {
          ...vmResult,
           owner_user_id: vmResult.owner_user_id || storedConfig.config?.vm?.owner_user_id || null,
           network_group_id: vmResult.network_group_id || storedConfig.config?.vm?.network_group_id || null,
           allow_same_group_traffic: vmResult.allow_same_group_traffic ?? storedConfig.config?.vm?.allow_same_group_traffic ?? true,
           allow_host_access: vmResult.allow_host_access ?? storedConfig.config?.vm?.allow_host_access ?? true,
           allow_private_lan_access: vmResult.allow_private_lan_access ?? storedConfig.config?.vm?.allow_private_lan_access ?? false,
           internet_access: vmResult.internet_access ?? storedConfig.config?.vm?.internet_access ?? true,
          mac_address: vmResult.mac_address || storedConfig.config?.vm?.mac_address || storedConfig.config?.network?.mac || null,
          ip_address: vmResult.ip_address || storedConfig.config?.vm?.ip_address || storedConfig.config?.network?.vm_ip || null,
          network: vmResult.network
            ? { ...(storedConfig.config?.network || {}), ...vmResult.network }
            : (storedConfig.config?.network || null),
          ports: vmResult.ports?.length ? vmResult.ports : (storedConfig.config?.ports || []),
          configured: true,
          storedConfigPath: storedConfig.configPath,
          storedConfig: storedConfig.config,
          provisionerError: vmResult.provisionerError || null,
        },
      });
    }),
  );

  app.get(
    '/api/vms/:name/config',
    asyncRoute(async (request, response) => {
      const storedConfig = await requireStoredConfig(deps, request.params.name);
      response.json(storedConfig);
    }),
  );

  app.delete(
    '/api/vms/:name',
    asyncRoute(async (request, response) => {
      await requireStoredConfig(deps, request.params.name);
      const destroyed = await deps.destroyVm(request.params.name);
      response.json({
        name: request.params.name,
        destroyed,
      });
    }),
  );

  app.post(
    '/api/vms/:name/start',
    asyncRoute(async (request, response) => {
      await requireStoredConfig(deps, request.params.name);
      const started = await deps.startVm(request.params.name);
      response.json({
        name: request.params.name,
        started,
      });
    }),
  );

  app.post(
    '/api/vms/:name/stop',
    asyncRoute(async (request, response) => {
      await requireStoredConfig(deps, request.params.name);
      const stopped = await deps.stopVm(request.params.name);
      response.json({
        name: request.params.name,
        stopped,
      });
    }),
  );

  app.post(
    '/api/vms/:name/clone',
    asyncRoute(async (request, response) => {
      await requireStoredConfig(deps, request.params.name);
      const payload = await deps.prepareVmConfigForSave(deps.parseCreateVmRequest(request.body));
      await assertVmNameIsAvailable(deps, payload.config.vm.name);
      const savedConfig = await deps.saveVmConfig(payload);
      const cloned = await deps.cloneVm(request.params.name, savedConfig.configPath);

      response.status(201).json({
        sourceName: request.params.name,
        ...savedConfig,
        cloned,
      });
    }),
  );

  app.patch(
    '/api/vms/:name/policy',
    asyncRoute(async (request, response) => {
      const storedConfig = await requireStoredConfig(deps, request.params.name);
      const updates = deps.parseVmPolicyRequest(request.body);
      const nextConfig = JSON.parse(JSON.stringify(storedConfig.config || {}));
      nextConfig.vm = {
        ...(nextConfig.vm || {}),
        ...updates,
      };

      const preparedPayload = await deps.prepareVmConfigForSave(
        { config: nextConfig },
        { existingVmName: request.params.name },
      );
      const savedConfig = await deps.saveVmConfig(preparedPayload, { overwrite: true });
      await deps.reconcileVmNetworking({ policyOnly: true });
      response.json({
        vmName: request.params.name,
        configPath: savedConfig.configPath,
        config: savedConfig.config,
      });
    }),
  );

  app.post(
    '/api/vms/:name/snapshots',
    asyncRoute(async (request, response) => {
      await requireStoredConfig(deps, request.params.name);
      const snapshot = await deps.createVmSnapshot(request.params.name);
      response.status(201).json({
        name: request.params.name,
        snapshot,
      });
    }),
  );

  app.post(
    '/api/vms/:name/snapshots/:snapshotId/restore',
    asyncRoute(async (request, response) => {
      await requireStoredConfig(deps, request.params.name);
      const restored = await deps.restoreVmSnapshot(request.params.name, request.params.snapshotId);
      response.json({
        name: request.params.name,
        snapshotId: request.params.snapshotId,
        restored,
      });
    }),
  );

  app.delete(
    '/api/vms/:name/snapshots/:snapshotId',
    asyncRoute(async (request, response) => {
      await requireStoredConfig(deps, request.params.name);
      const deleted = await deps.deleteVmSnapshot(request.params.name, request.params.snapshotId);
      response.json({
        name: request.params.name,
        snapshotId: request.params.snapshotId,
        deleted,
      });
    }),
  );

  app.get(
    '/api/vms/:name/logs',
    asyncRoute(async (request, response) => {
      await requireStoredConfig(deps, request.params.name);
      const lines = parseLines(request.query.lines, 200);
      const log = await deps.readVmLog(request.params.name, lines);
      response.json({
        name: request.params.name,
        lines,
        log,
      });
    }),
  );

  app.get(
    '/api/vms/:name/logs/stream',
    asyncRoute(async (request, response) => {
      await requireStoredConfig(deps, request.params.name);
      const lines = parseLines(request.query.lines, 100);
      await deps.streamVmLog(request.params.name, response, lines);
    }),
  );

  app.use((request, response) => {
    response.status(404).json({
      error: 'Route not found',
    });
  });

  app.use((error, _request, response, _next) => {
    if (deps.isValidationError(error)) {
      response.status(400).json({
        error: 'Validation failed',
        details: deps.formatValidationError(error),
      });
      return;
    }

    if (error instanceof SyntaxError && 'body' in error) {
      response.status(400).json({
        error: 'Request body must be valid JSON',
      });
      return;
    }

    response.status(error.statusCode || 500).json({
      error: error.message || 'Internal server error',
      details: error.details || null,
    });
  });

  return app;
}

const app = createApp();

export default app;
