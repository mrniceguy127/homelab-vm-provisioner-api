import express from 'express';

import { listStoredConfigNames, loadStoredConfig, saveVmConfig } from './config-store.js';
import { createVm, destroyVm, inspectVm, listVms, readVmLog, streamVmLog } from './provisioner.js';
import { formatValidationError, isValidationError, parseCreateVmRequest } from './validation.js';

const app = express();

function asyncRoute(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function parseLines(rawValue, fallback) {
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

app.use(express.json({ limit: '1mb' }));

app.get('/health', (_request, response) => {
  response.json({ ok: true });
});

app.post(
  '/api/vms/configs',
  asyncRoute(async (request, response) => {
    const payload = parseCreateVmRequest(request.body);
    const savedConfig = await saveVmConfig(payload);

    response.status(201).json(savedConfig);
  }),
);

app.post(
  '/api/vms',
  asyncRoute(async (request, response) => {
    const payload = parseCreateVmRequest(request.body);
    const savedConfig = await saveVmConfig(payload);
    const provisioned = await createVm(savedConfig.configPath);

    response.status(201).json({
      ...savedConfig,
      provisioned,
    });
  }),
);

app.get(
  '/api/vms',
  asyncRoute(async (_request, response) => {
    const [vms, storedConfigNames] = await Promise.all([listVms(), listStoredConfigNames()]);
    const configuredNames = new Set(storedConfigNames);
    const merged = new Map();

    for (const name of storedConfigNames) {
      merged.set(name, {
        name,
        configured: true,
      });
    }

    for (const vm of vms) {
      merged.set(vm.name, {
        ...(merged.get(vm.name) || {}),
        ...vm,
        configured: configuredNames.has(vm.name) || Boolean(vm.config_path),
      });
    }

    response.json({
      vms: [...merged.values()].sort((left, right) => left.name.localeCompare(right.name)),
    });
  }),
);

app.get(
  '/api/vms/:name',
  asyncRoute(async (request, response) => {
    const [vm, configResult] = await Promise.allSettled([
      inspectVm(request.params.name),
      loadStoredConfig(request.params.name),
    ]);

    if (vm.status === 'rejected' && configResult.status !== 'fulfilled') {
      throw vm.reason;
    }

    const vmDetails = vm.status === 'fulfilled' ? vm.value : null;
    const storedConfig = configResult.status === 'fulfilled' ? configResult.value : null;
    const provisionerError = vm.status === 'rejected' ? vm.reason?.message || 'Unable to query provisioner state' : null;

    if (!vmDetails?.exists && !storedConfig) {
      const error = new Error(`VM was not found: ${request.params.name}`);
      error.statusCode = 404;
      throw error;
    }

    response.json({
      vm: {
        ...(vmDetails || { name: request.params.name, exists: false }),
        configured: Boolean(storedConfig),
        storedConfigPath: storedConfig?.configPath || null,
        storedConfig: storedConfig?.config || null,
        provisionerError,
      },
    });
  }),
);

app.get(
  '/api/vms/:name/config',
  asyncRoute(async (request, response) => {
    const storedConfig = await loadStoredConfig(request.params.name);
    response.json(storedConfig);
  }),
);

app.delete(
  '/api/vms/:name',
  asyncRoute(async (request, response) => {
    const destroyed = await destroyVm(request.params.name);
    response.json({
      name: request.params.name,
      destroyed,
    });
  }),
);

app.get(
  '/api/vms/:name/logs',
  asyncRoute(async (request, response) => {
    const lines = parseLines(request.query.lines, 200);
    const log = await readVmLog(request.params.name, lines);
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
    const lines = parseLines(request.query.lines, 100);
    await streamVmLog(request.params.name, response, lines);
  }),
);

app.use((request, response) => {
  response.status(404).json({
    error: 'Route not found',
  });
});

app.use((error, _request, response, _next) => {
  if (isValidationError(error)) {
    response.status(400).json({
      error: 'Validation failed',
      details: formatValidationError(error),
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

export default app;
