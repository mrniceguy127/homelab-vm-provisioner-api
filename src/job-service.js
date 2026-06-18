/**
 * Job service for enqueueing and managing VM operation jobs
 * 
 * Provides a clean interface for creating jobs that will be processed
 * by the worker daemon.
 */

/**
 * Create an error with a specific HTTP status code
 * 
 * @param {string} message - Error message
 * @param {number} statusCode - HTTP status code
 * @returns {Error} Error with statusCode property
 */
function createJobServiceError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * Create a job service instance
 * 
 * @param {object} options - Service options
 * @param {object} options.repository - Job repository client
 * @param {string|null} options.hostId - API host ID (null if not configured)
 * @returns {object} Job service
 */
export function createJobService({ repository, hostId }) {
  /**
   * Ensure host ID is configured
   * 
   * @throws {Error} If host ID is not configured
   */
  function requireHostId() {
    if (!hostId) {
      throw createJobServiceError(
        'API_HOST_ID is not configured. Cannot enqueue jobs without a target host.',
        500
      );
    }
  }
  
  return {
    /**
     * Enqueue a VM provision job
     * 
     * @param {string} vmName - VM name
     * @param {string} configPath - Path to VM configuration file
     * @returns {Promise<object>} Created job
     */
    async enqueueVmProvisionJob(vmName, configPath) {
      requireHostId();
      
      return repository.enqueueJob(
        'provision_vm',
        hostId,
        { configPath },
        { targetVmId: vmName, maxAttempts: 3 }
      );
    },
    
    /**
     * Enqueue a VM destroy job
     * 
     * @param {string} vmName - VM name
     * @returns {Promise<object>} Created job
     */
    async enqueueVmDestroyJob(vmName) {
      requireHostId();
      
      return repository.enqueueJob(
        'destroy_vm',
        hostId,
        { vmName },
        { targetVmId: vmName, maxAttempts: 1 }
      );
    },
    
    /**
     * Enqueue a VM clone job
     * 
     * @param {string} sourceVmName - Source VM name
     * @param {string} targetVmName - Target VM name
     * @param {string} configPath - Path to target VM configuration file
     * @returns {Promise<object>} Created job
     */
    async enqueueVmCloneJob(sourceVmName, targetVmName, configPath) {
      requireHostId();
      
      return repository.enqueueJob(
        'clone_vm',
        hostId,
        { sourceVmName, configPath },
        { targetVmId: targetVmName, maxAttempts: 3 }
      );
    },
    
    /**
     * Enqueue a VM networking reconcile job
     * 
     * @param {object} options - Reconcile options
     * @param {boolean} options.policyOnly - Only reconcile policy, not full networking
     * @returns {Promise<object>} Created job
     */
    async enqueueVmReconcileJob(options = {}) {
      requireHostId();
      
      return repository.enqueueJob(
        'reconcile_vm_networking',
        hostId,
        options,
        { targetVmId: null, maxAttempts: 1 }
      );
    },
    
    /**
     * Get job by ID
     * 
     * @param {number} jobId - Job ID
     * @returns {Promise<object|null>} Job or null if not found
     */
    async getJobById(jobId) {
      return repository.getJob(jobId);
    },
    
    /**
     * Get job events
     * 
     * @param {number} jobId - Job ID
     * @param {number} limit - Maximum number of events (default: 100)
     * @returns {Promise<Array<object>>} Job events
     */
    async getJobEvents(jobId, limit = 100) {
      return repository.listJobEvents(jobId, limit);
    },
  };
}
