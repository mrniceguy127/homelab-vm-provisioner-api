import express from 'express';

import {
  configPathForVm,
  deleteSavedConfigArtifacts,
  listStoredConfigNames,
  loadStoredConfig,
  prepareVmConfigForSave,
  saveVmConfig,
} from './vm-definitions.js';
import {
  getRepository,
  isDatabaseAvailable,
  loadStoredVmRuntimeState,
  upsertStoredVmDefinitionAndEnqueueJob,
} from './db.js';
import { createJobService } from './job-service.js';
import {
  createNetworkGroup,
  listNetworkGroups,
  listUsers,
} from './network-model.js';
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
  parseCreateVmRequest,
  parseNetworkGroupRequest,
  parseVmPolicyRequest,
  formatValidationError,
  isValidationError,
  getRepository,
  isDatabaseAvailable,
  loadStoredVmRuntimeState,
  upsertStoredVmDefinitionAndEnqueueJob,
  createJobService,
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
 * Ensure a VM name is unique across saved configs.
 *
 * @param {object} deps - Dependency bag for config lookups.
 * @param {Function} deps.listStoredConfigNames - Returns saved config names.
 * @param {string} vmName - Candidate VM name.
 * @returns {Promise<void>} Resolves when the name is available.
 * @throws {Error} Throws an HTTP 409 conflict when the name is already used.
 */
export async function assertVmNameIsAvailable(deps, vmName) {
  const normalizedVmName = normalizeVmName(vmName);
  const storedConfigNames = await deps.listStoredConfigNames();

  if (storedConfigNames.some((name) => normalizeVmName(name) === normalizedVmName)) {
    throw createConflictError(`VM name is already used by a saved config: ${vmName}`);
  }
}

/**
 * Build a VM response object from stored config and runtime state.
 *
 * @param {string} vmName - VM name.
 * @param {object} storedConfig - Stored VM configuration.
 * @param {object|null} runtimeState - Runtime state from database (or null).
 * @returns {object} VM response object.
 */
function buildVmResponse(vmName, storedConfig, runtimeState) {
  const storedVm = storedConfig.config?.vm || {};
  const storedNetwork = storedConfig.config?.network || {};

  if (runtimeState) {
    return {
      name: vmName,
      exists: runtimeState.status !== 'destroyed',
      status: runtimeState.status || 'unknown',
      owner_user_id: runtimeState.owner_user_id || storedVm.owner_user_id || null,
      network_group_id: runtimeState.network_group_id || storedVm.network_group_id || null,
      allow_same_group_traffic: storedVm.allow_same_group_traffic ?? true,
      allow_host_access: storedVm.allow_host_access ?? true,
      allow_private_lan_access: storedVm.allow_private_lan_access ?? false,
      internet_access: storedVm.internet_access ?? true,
      mac_address: runtimeState.mac_address || storedVm.mac_address || storedNetwork.mac || null,
      ip_address: runtimeState.ip_address || storedVm.ip_address || storedNetwork.vm_ip || null,
      network: Object.keys(runtimeState.network || {}).length > 0
        ? runtimeState.network
        : (Object.keys(storedNetwork).length > 0 ? storedNetwork : null),
      ports: runtimeState.ports || storedConfig.config?.ports || [],
      configured: true,
      storedConfigPath: storedConfig.configPath,
      storedConfig: storedConfig.config,
      runtimeState,
    };
  }

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
  };
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

  // Initialize job service if database is available
  const hostId = process.env.HOST_ID || null;
  const workerSocket = process.env.WORKER_SOCKET || null;
  let jobService = null;
  
  if (deps.isDatabaseAvailable()) {
    try {
      const repository = deps.getRepository();
      jobService = deps.createJobService({ repository, hostId, workerSocket });
    } catch (error) {
      console.warn('Failed to initialize job service:', error.message);
    }
  }

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

  // VM Configs (Definitions) - these are templates, not running VMs
  app.get(
    '/api/configs',
    asyncRoute(async (_request, response) => {
      if (!deps.isDatabaseAvailable()) {
        const error = new Error('VM templates not available without database connection.');
        error.statusCode = 503;
        throw error;
      }
      
      const { listStoredVmDefinitions } = await import('./db.js');
      const configs = await listStoredVmDefinitions();
      response.json({ configs });
    }),
  );

  app.post(
    '/api/configs',
    asyncRoute(async (request, response) => {
      const payload = await deps.prepareVmConfigForSave(deps.parseCreateVmRequest(request.body));
      await assertVmNameIsAvailable(deps, payload.config.vm.name);
      const savedConfig = await deps.saveVmConfig(payload);

      response.status(201).json(savedConfig);
    }),
  );

  // Legacy endpoint - kept for backwards compatibility
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
      const savedConfig = await deps.saveVmConfig(payload, { persist: !jobService });
      
      if (!jobService) {
        const error = new Error('Job queue unavailable. VM provisioning requires database connection.');
        error.statusCode = 503;
        throw error;
      }
      
      // Enqueue job
      const persisted = await deps.upsertStoredVmDefinitionAndEnqueueJob(
        {
          vm_name: savedConfig.vmName,
          owner_user_id: savedConfig.config.vm.owner_user_id || null,
          network_group_id: savedConfig.config.vm.network_group_id || null,
          target_host_id: hostId,
          config: savedConfig.config,
          ssh_public_key: payload.sshPublicKey ? `${payload.sshPublicKey.trim()}\n` : null,
          setup_script: payload.setupScript ? `${payload.setupScript.trim()}\n` : null,
        },
        'provision_vm',
        { vmName: savedConfig.vmName },
        { targetVmId: savedConfig.vmName, maxAttempts: 3, targetHostId: hostId },
      );
      const job = persisted.job;
      
      response.status(202).json({
        ...savedConfig,
        vmDefinitionId: persisted.vmDefinition.id,
        job_id: job.id,
        status: job.status,
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

      if (!jobService) {
        const error = new Error('Job queue unavailable. VM provisioning requires database connection.');
        error.statusCode = 503;
        throw error;
      }
      
      // Enqueue job
      const job = await jobService.enqueueVmProvisionJob(request.params.name);
      
      response.status(202).json({
        name: request.params.name,
        configPath: storedConfig.configPath,
        job_id: job.id,
        status: job.status,
      });
    }),
  );

  app.get(
    '/api/vms',
    asyncRoute(async (_request, response) => {
      const storedConfigNames = await deps.listStoredConfigNames();
      const vms = await Promise.all(
        storedConfigNames.map(async (name) => {
          const storedConfig = await deps.loadStoredConfig(name);
          const runtimeStateRecord = await deps.loadStoredVmRuntimeState(name);
          const runtimeState = runtimeStateRecord?.state || null;
          return buildVmResponse(name, storedConfig, runtimeState);
        }),
      );

      response.json({
        vms: vms.sort((left, right) => left.name.localeCompare(right.name)),
      });
    }),
  );

  app.get(
    '/api/vms/:name',
    asyncRoute(async (request, response) => {
      const vmName = request.params.name;
      const storedConfig = await deps.loadStoredConfig(vmName);
      const runtimeStateRecord = await deps.loadStoredVmRuntimeState(vmName);
      const runtimeState = runtimeStateRecord?.state || null;
      const vm = buildVmResponse(vmName, storedConfig, runtimeState);

      response.json({ vm });
    }),
  );

  app.get(
    '/api/vms/:name/config',
    asyncRoute(async (request, response) => {
      const storedConfig = await requireStoredConfig(deps, request.params.name);
      response.json(storedConfig);
    }),
  );

  // Get VM state - combines original config + current runtime state
  app.get(
    '/api/vms/:name/state',
    asyncRoute(async (request, response) => {
      if (!deps.isDatabaseAvailable()) {
        const error = new Error('VM state not available without database connection.');
        error.statusCode = 503;
        throw error;
      }
      
      const vmName = request.params.name;
      const { loadStoredVmDefinitionByName, loadStoredVmRuntimeState } = await import('./db.js');
      
      // Load original VM definition (creation config)
      const vmDefinition = await loadStoredVmDefinitionByName(vmName);
      if (!vmDefinition) {
        const error = new Error(`VM definition not found: ${vmName}`);
        error.statusCode = 404;
        throw error;
      }
      
      // Load current runtime state (may be null if VM never started)
      const runtimeState = await loadStoredVmRuntimeState(vmName);
      
      response.json({
        vm_name: vmName,
        original_config: {
          ...vmDefinition,
          label: 'Original Creation Config',
          note: 'This is the configuration used when the VM was created. Runtime state may drift from this.',
        },
        runtime_state: runtimeState || {
          state: null,
          observed_at: null,
          observation_source: null,
          note: 'No runtime state available. VM may not have been started yet.',
        },
      });
    }),
  );

  app.delete(
    '/api/vms/:name',
    asyncRoute(async (request, response) => {
      await requireStoredConfig(deps, request.params.name);
      
      if (!jobService) {
        const error = new Error('Job queue unavailable. VM operations require database connection.');
        error.statusCode = 503;
        throw error;
      }
      
      const job = await jobService.enqueueVmDestroyJob(request.params.name);
      
      response.status(202).json({
        name: request.params.name,
        job_id: job.id,
        status: job.status,
      });
    }),
  );

  app.post(
    '/api/vms/:name/start',
    asyncRoute(async (request, response) => {
      await requireStoredConfig(deps, request.params.name);

      if (!jobService) {
        const error = new Error('Job queue unavailable. VM operations require database connection.');
        error.statusCode = 503;
        throw error;
      }

      const job = await jobService.enqueueVmStartJob(request.params.name);
      response.status(202).json({
        name: request.params.name,
        job_id: job.id,
        status: job.status,
      });
    }),
  );

  app.post(
    '/api/vms/:name/stop',
    asyncRoute(async (request, response) => {
      await requireStoredConfig(deps, request.params.name);

      if (!jobService) {
        const error = new Error('Job queue unavailable. VM operations require database connection.');
        error.statusCode = 503;
        throw error;
      }

      const job = await jobService.enqueueVmStopJob(request.params.name);
      response.status(202).json({
        name: request.params.name,
        job_id: job.id,
        status: job.status,
      });
    }),
  );

  app.post(
    '/api/vms/:name/clone',
    asyncRoute(async (request, response) => {
      await requireStoredConfig(deps, request.params.name);
      const payload = await deps.prepareVmConfigForSave(deps.parseCreateVmRequest(request.body));
      await assertVmNameIsAvailable(deps, payload.config.vm.name);
      const savedConfig = await deps.saveVmConfig(payload, { persist: !jobService });
      
      if (!jobService) {
        const error = new Error('Job queue unavailable. VM cloning requires database connection.');
        error.statusCode = 503;
        throw error;
      }
      
      // Enqueue job
      const persisted = await deps.upsertStoredVmDefinitionAndEnqueueJob(
        {
          vm_name: savedConfig.vmName,
          owner_user_id: savedConfig.config.vm.owner_user_id || null,
          network_group_id: savedConfig.config.vm.network_group_id || null,
          target_host_id: hostId,
          config: savedConfig.config,
          ssh_public_key: payload.sshPublicKey ? `${payload.sshPublicKey.trim()}\n` : null,
          setup_script: payload.setupScript ? `${payload.setupScript.trim()}\n` : null,
        },
        'clone_vm',
        { sourceVmName: request.params.name, targetVmName: savedConfig.vmName },
        { targetVmId: savedConfig.vmName, maxAttempts: 3, targetHostId: hostId },
      );
      const job = persisted.job;

      response.status(202).json({
        sourceName: request.params.name,
        ...savedConfig,
        vmDefinitionId: persisted.vmDefinition.id,
        job_id: job.id,
        status: job.status,
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
      const savedConfig = await deps.saveVmConfig(preparedPayload, { overwrite: true, persist: !jobService });
      
      if (!jobService) {
        const error = new Error('Job queue unavailable. Policy updates require database connection.');
        error.statusCode = 503;
        throw error;
      }
      
      // Enqueue job
      const persisted = await deps.upsertStoredVmDefinitionAndEnqueueJob(
        {
          vm_name: savedConfig.vmName,
          owner_user_id: savedConfig.config.vm.owner_user_id || null,
          network_group_id: savedConfig.config.vm.network_group_id || null,
          target_host_id: hostId,
          config: savedConfig.config,
          ssh_public_key: null,
          setup_script: null,
        },
        'reconcile_vm_networking',
        { policyOnly: true },
        { targetVmId: null, maxAttempts: 1, targetHostId: hostId },
      );
      const job = persisted.job;
      
      response.status(202).json({
        vmName: request.params.name,
        configPath: savedConfig.configPath,
        config: savedConfig.config,
        vmDefinitionId: persisted.vmDefinition.id,
        job_id: job.id,
        status: job.status,
      });
    }),
  );

  app.post(
    '/api/vms/:name/snapshots',
    asyncRoute(async (request, response) => {
      await requireStoredConfig(deps, request.params.name);

      if (!jobService) {
        const error = new Error('Job queue unavailable. Snapshot operations require database connection.');
        error.statusCode = 503;
        throw error;
      }

      const job = await jobService.enqueueVmSnapshotCreateJob(request.params.name);
      response.status(202).json({
        name: request.params.name,
        job_id: job.id,
        status: job.status,
      });
    }),
  );

  app.post(
    '/api/vms/:name/snapshots/:snapshotId/restore',
    asyncRoute(async (request, response) => {
      await requireStoredConfig(deps, request.params.name);

      if (!jobService) {
        const error = new Error('Job queue unavailable. Snapshot operations require database connection.');
        error.statusCode = 503;
        throw error;
      }

      const job = await jobService.enqueueVmSnapshotRestoreJob(
        request.params.name,
        request.params.snapshotId,
      );
      response.status(202).json({
        name: request.params.name,
        snapshotId: request.params.snapshotId,
        job_id: job.id,
        status: job.status,
      });
    }),
  );

  app.delete(
    '/api/vms/:name/snapshots/:snapshotId',
    asyncRoute(async (request, response) => {
      await requireStoredConfig(deps, request.params.name);

      if (!jobService) {
        const error = new Error('Job queue unavailable. Snapshot operations require database connection.');
        error.statusCode = 503;
        throw error;
      }

      const job = await jobService.enqueueVmSnapshotDeleteJob(
        request.params.name,
        request.params.snapshotId,
      );
      response.status(202).json({
        name: request.params.name,
        snapshotId: request.params.snapshotId,
        job_id: job.id,
        status: job.status,
      });
    }),
  );

  app.get(
    '/api/jobs/:id',
    asyncRoute(async (request, response) => {
      if (!jobService) {
        const error = new Error('Job queue is not available. Database connection required.');
        error.statusCode = 503;
        throw error;
      }
      
      const jobId = Number.parseInt(request.params.id, 10);
      if (Number.isNaN(jobId)) {
        const error = new Error('Job ID must be a valid number');
        error.statusCode = 400;
        throw error;
      }
      
      const job = await jobService.getJobById(jobId);
      
      if (!job) {
        const error = new Error(`Job not found: ${jobId}`);
        error.statusCode = 404;
        throw error;
      }
      
      response.json({ job });
    }),
  );

  app.get(
    '/api/jobs/:id/events',
    asyncRoute(async (request, response) => {
      if (!jobService) {
        const error = new Error('Job queue is not available. Database connection required.');
        error.statusCode = 503;
        throw error;
      }
      
      const jobId = Number.parseInt(request.params.id, 10);
      if (Number.isNaN(jobId)) {
        const error = new Error('Job ID must be a valid number');
        error.statusCode = 400;
        throw error;
      }
      
      const limit = request.query.limit
        ? Number.parseInt(request.query.limit, 10)
        : 100;
      
      if (Number.isNaN(limit) || limit < 1 || limit > 1000) {
        const error = new Error('limit must be an integer between 1 and 1000');
        error.statusCode = 400;
        throw error;
      }
      
      const events = await jobService.getJobEvents(jobId, limit);
      
      response.json({ events });
    }),
  );

  // VM Logs endpoints (database-backed)
  app.get(
    '/api/vms/:name/logs',
    asyncRoute(async (request, response) => {
      if (!deps.isDatabaseAvailable()) {
        const error = new Error('VM logs not available without database connection.');
        error.statusCode = 404;
        throw error;
      }
      
      const vmName = request.params.name;
      const { getVmLogSnapshot } = await import('./db.js');
      
      const logSnapshot = await getVmLogSnapshot(vmName);
      
      if (!logSnapshot) {
        const error = new Error(`VM logs not available for: ${vmName}. Worker must collect logs first.`);
        error.statusCode = 404;
        throw error;
      }
      
      response.json({
        vm_name: vmName,
        snapshot_at: logSnapshot.snapshot_at,
        line_count: logSnapshot.line_count,
        log_content: logSnapshot.log_content,
        collected_by: logSnapshot.collected_by,
      });
    }),
  );

  app.get(
    '/api/logs',
    asyncRoute(async (request, response) => {
      if (!deps.isDatabaseAvailable()) {
        const error = new Error('VM logs not available without database connection.');
        error.statusCode = 404;
        throw error;
      }
      
      const { listVmLogSnapshots } = await import('./db.js');
      const snapshots = await listVmLogSnapshots();
      response.json({ snapshots });
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

export default createApp;
