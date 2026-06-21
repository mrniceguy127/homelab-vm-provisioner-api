/**
 * Database microservice client
 * 
 * Communicates with the homelab-vm-provisioner-db microservice
 * instead of directly accessing PostgreSQL.
 */

const DB_SERVICE_URL = process.env.DB_SERVICE_URL || 'http://172.17.0.1:3002';
const DB_SERVICE_PASSWORD = process.env.DB_SERVICE_PASSWORD || 'changeme_db_secret';

/**
 * Make a request to the database microservice
 * 
 * @param {string} path - API path
 * @param {object} options - Fetch options
 * @returns {Promise<any>} Response data
 */
async function dbRequest(path, options = {}) {
  const url = `${DB_SERVICE_URL}${path}`;
  
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DB_SERVICE_PASSWORD}`,
      ...options.headers,
    },
  });
  
  const data = await response.json();
  
  if (!response.ok) {
    const error = new Error(data.error || 'Database microservice request failed');
    error.statusCode = response.status;
    throw error;
  }
  
  return data;
}

/**
 * Job repository client
 */
class JobRepositoryClient {
  async enqueueJob(type, targetHostId, payload, options = {}) {
    const { targetVmId, maxAttempts } = options;
    
    const result = await dbRequest('/jobs', {
      method: 'POST',
      body: JSON.stringify({
        type,
        targetHostId,
        targetVmId,
        payload,
        maxAttempts,
      }),
    });
    
    return result.job;
  }
  
  async getJob(jobId) {
    const result = await dbRequest(`/jobs/${jobId}`);
    return result.job;
  }
  
  async listJobs(filters = {}) {
    const { status, targetHostId, limit } = filters;
    const params = new URLSearchParams();
    
    if (status) params.append('status', status);
    if (targetHostId) params.append('targetHostId', targetHostId);
    if (limit) params.append('limit', limit.toString());
    
    const query = params.toString();
    const path = query ? `/jobs?${query}` : '/jobs';
    
    const result = await dbRequest(path);
    return result.jobs;
  }
  
  async appendJobEvent(jobId, level, message, metadata = null) {
    const result = await dbRequest(`/jobs/${jobId}/events`, {
      method: 'POST',
      body: JSON.stringify({ level, message, metadata }),
    });
    
    return result.event;
  }
  
  async listJobEvents(jobId, limit = 100) {
    const result = await dbRequest(`/jobs/${jobId}/events?limit=${limit}`);
    return result.events;
  }
  
  async claimNextJobForHost(targetHostId, workerId) {
    try {
      const result = await dbRequest('/jobs/claim', {
        method: 'POST',
        body: JSON.stringify({ targetHostId, workerId }),
      });
      
      return result.job;
    } catch (error) {
      if (error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }
  
  async markJobRunning(jobId, workerId) {
    const result = await dbRequest(`/jobs/${jobId}/running`, {
      method: 'POST',
      body: JSON.stringify({ workerId }),
    });
    
    return result.job;
  }
  
  async markJobSucceeded(jobId, result = {}) {
    const response = await dbRequest(`/jobs/${jobId}/succeeded`, {
      method: 'POST',
      body: JSON.stringify({ result }),
    });
    
    return response.job;
  }
  
  async markJobFailed(jobId, error, retriable = false) {
    const result = await dbRequest(`/jobs/${jobId}/failed`, {
      method: 'POST',
      body: JSON.stringify({ error, retriable }),
    });
    
    return result.job;
  }
  
  async cancelQueuedJob(jobId) {
    const result = await dbRequest(`/jobs/${jobId}/cancel`, {
      method: 'POST',
    });
    
    return result.job;
  }
  
  async acquireResourceLocks(jobId, workerId, lockKeys, ttlMs = 300000) {
    const result = await dbRequest('/locks/acquire', {
      method: 'POST',
      body: JSON.stringify({ jobId, workerId, lockKeys, ttlMs }),
    });
    
    return result.acquired;
  }
  
  async releaseResourceLocks(jobId, workerId = null) {
    const result = await dbRequest('/locks/release', {
      method: 'POST',
      body: JSON.stringify({ jobId, workerId }),
    });
    
    return result.released;
  }
  
  async cleanupExpiredLocks() {
    const result = await dbRequest('/locks/cleanup', {
      method: 'POST',
    });
    
    return result.cleaned;
  }
}

let globalRepository = null;

/**
 * Initialize database microservice client
 * 
 * @param {string} serviceUrl - Database microservice URL
 * @returns {Promise<void>}
 */
export async function initializeDatabase(serviceUrl = null) {
  const url = serviceUrl || DB_SERVICE_URL;
  
  if (!url) {
    console.warn('DB_SERVICE_URL not set. Job queue features will be unavailable.');
    return;
  }
  
  if (globalRepository) {
    console.warn('Database client already initialized');
    return;
  }
  
  try {
    // Test connection with health check
    const response = await fetch(`${url}/health`);
    
    if (!response.ok) {
      throw new Error(`Health check failed with status ${response.status}`);
    }
    
    const health = await response.json();
    
    if (!health.ok) {
      throw new Error('Database microservice health check returned not ok');
    }
    
    globalRepository = new JobRepositoryClient();
    
    console.log('Database microservice client initialized');
    console.log(`Connected to: ${url}`);
  } catch (error) {
    console.error('Failed to connect to database microservice:', error.message);
    throw error;
  }
}

/**
 * Get the global repository instance
 * 
 * @returns {JobRepositoryClient|null} Repository instance or null if not initialized
 */
export function getRepository() {
  return globalRepository;
}

/**
 * Check if database is available
 * 
 * @returns {boolean} True if database is initialized
 */
export function isDatabaseAvailable() {
  return globalRepository !== null;
}

export async function listStoredUsers() {
  const result = await dbRequest('/users');
  return result.users;
}

export async function upsertStoredUser(user) {
  const result = await dbRequest('/users', {
    method: 'POST',
    body: JSON.stringify(user),
  });
  return result.user;
}

export async function listStoredNetworkGroups() {
  const result = await dbRequest('/network-groups');
  return result.networkGroups;
}

export async function upsertStoredNetworkGroup(networkGroup) {
  const result = await dbRequest('/network-groups', {
    method: 'POST',
    body: JSON.stringify(networkGroup),
  });
  return result.networkGroup;
}

export async function listStoredVmDefinitions() {
  const result = await dbRequest('/vm-definitions');
  return result.vmDefinitions;
}

export async function loadStoredVmDefinitionByName(vmName) {
  const result = await dbRequest(`/vm-definitions/by-name/${encodeURIComponent(vmName)}`);
  return result.vmDefinition;
}

export async function upsertStoredVmDefinition(vmDefinition) {
  const result = await dbRequest('/vm-definitions', {
    method: 'POST',
    body: JSON.stringify(vmDefinition),
  });
  return result.vmDefinition;
}

export async function upsertStoredVmDefinitionAndEnqueueJob(vmDefinition, jobType, jobPayload, jobOptions = {}) {
  const result = await dbRequest('/vm-definition-jobs', {
    method: 'POST',
    body: JSON.stringify({ vmDefinition, jobType, jobPayload, jobOptions }),
  });
  return result;
}

export async function deleteStoredVmDefinition(vmName) {
  const result = await dbRequest(`/vm-definitions/by-name/${encodeURIComponent(vmName)}`, {
    method: 'DELETE',
  });
  return result.vmDefinition;
}

export async function listStoredVmRuntimeStates() {
  const result = await dbRequest('/vm-runtime-state');
  return result.runtimeStates;
}

export async function loadStoredVmRuntimeState(vmName) {
  try {
    const result = await dbRequest(`/vm-runtime-state/${encodeURIComponent(vmName)}`);
    return result.runtimeState;
  } catch (error) {
    if (error.statusCode === 404) {
      return null;
    }
    throw error;
  }
}

export async function upsertStoredVmRuntimeState(vmName, state) {
  const result = await dbRequest(`/vm-runtime-state/${encodeURIComponent(vmName)}`, {
    method: 'POST',
    body: JSON.stringify({ state }),
  });
  return result.runtimeState;
}

export async function deleteStoredVmRuntimeState(vmName) {
  try {
    const result = await dbRequest(`/vm-runtime-state/${encodeURIComponent(vmName)}`, {
      method: 'DELETE',
    });
    return result.runtimeState;
  } catch (error) {
    if (error.statusCode === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Close database connection (no-op for HTTP client)
 * 
 * @returns {Promise<void>}
 */
export async function closeDatabase() {
  globalRepository = null;
}
