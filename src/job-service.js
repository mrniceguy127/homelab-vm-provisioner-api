/**
 * Job service for enqueueing and managing VM operation jobs
 * 
 * Provides a clean interface for creating jobs that will be processed
 * by the worker daemon via RabbitMQ.
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
 * @param {object|null} options.rabbitMqPublisher - RabbitMQ publisher (required)
 * @param {object} options.logger - Logger instance (default: console)
 * @returns {object} Job service
 */
export function createJobService({ repository, hostId, rabbitMqPublisher = null, logger = console }) {
  /**
   * Ensure host ID is configured
   * 
   * @throws {Error} If host ID is not configured
   */
  function requireHostId() {
    if (!hostId) {
      throw createJobServiceError(
        'HOST_ID is not configured. Cannot enqueue jobs without a target host.',
        500
      );
    }
  }

  /**
   * Ensure RabbitMQ is configured
   * 
   * @throws {Error} If RabbitMQ publisher is not configured
   */
  function requireRabbitMq() {
    if (!rabbitMqPublisher) {
      throw createJobServiceError(
        'RabbitMQ is not configured. Job queue requires RabbitMQ to dispatch jobs to workers.',
        500
      );
    }
  }
  
  /**
   * Publish job to RabbitMQ queue
   * 
   * @param {object} job - Job to publish
   * @returns {Promise<void>}
   * @throws {Error} If RabbitMQ publish fails
   */
  async function publishJobToQueue(job) {
    requireRabbitMq();
    
    try {
      await rabbitMqPublisher.publishJob({
        job_id: job.id,
        job_type: job.type,
        target_host_id: job.target_host_id
      });
      
      // Update job status to 'published' after successful RabbitMQ publish
      await repository.updateJobStatus(job.id, 'published', {
        queue_message_id: String(job.id) // Use job ID as message correlation ID
      });
      
      logger.info(`Job ${job.id} published to RabbitMQ successfully`);
    } catch (error) {
      logger.error(`Failed to publish job ${job.id} to RabbitMQ:`, error);
      
      // Update job status to 'publish_failed'
      await repository.updateJobStatus(job.id, 'publish_failed', {
        error: `RabbitMQ publish failed: ${error.message}`
      });
      
      throw createJobServiceError(
        `Failed to publish job to queue: ${error.message}`,
        500
      );
    }
  }
  
  return {
    /**
     * Enqueue a VM provision job
     * 
     * @param {string} vmName - VM name
     * @param {string} vmName - VM name
     * @returns {Promise<object>} Created job
     */
    async enqueueVmProvisionJob(vmName) {
      requireHostId();
      
      const job = await repository.enqueueJob(
        'provision_vm',
        hostId,
        { vmName },
        { targetVmId: vmName, maxAttempts: 3 }
      );
      
      await publishJobToQueue(job);
      return job;
    },
    
    /**
     * Enqueue a VM destroy job
     * 
     * @param {string} vmName - VM name
     * @returns {Promise<object>} Created job
     */
    async enqueueVmDestroyJob(vmName) {
      requireHostId();
      
      const job = await repository.enqueueJob(
        'destroy_vm',
        hostId,
        { vmName },
        { targetVmId: vmName, maxAttempts: 1 }
      );
      
      await publishJobToQueue(job);
      return job;
    },
    
    /**
     * Enqueue a VM clone job
     * 
     * @param {string} sourceVmName - Source VM name
     * @param {string} targetVmName - Target VM name
     * @param {string} targetVmName - Target VM name
     * @returns {Promise<object>} Created job
     */
    async enqueueVmCloneJob(sourceVmName, targetVmName) {
      requireHostId();
      
      const job = await repository.enqueueJob(
        'clone_vm',
        hostId,
        { sourceVmName, targetVmName },
        { targetVmId: targetVmName, maxAttempts: 3 }
      );
      
      await publishJobToQueue(job);
      return job;
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
      
      const job = await repository.enqueueJob(
        'reconcile_vm_networking',
        hostId,
        options,
        { targetVmId: null, maxAttempts: 1 }
      );
      
      await publishJobToQueue(job);
      return job;
    },

    async enqueueVmStartJob(vmName) {
      requireHostId();

      const job = await repository.enqueueJob(
        'start_vm',
        hostId,
        { vmName },
        { targetVmId: vmName, maxAttempts: 1 }
      );

      await publishJobToQueue(job);
      return job;
    },

    async enqueueVmStopJob(vmName) {
      requireHostId();

      const job = await repository.enqueueJob(
        'stop_vm',
        hostId,
        { vmName },
        { targetVmId: vmName, maxAttempts: 1 }
      );

      await publishJobToQueue(job);
      return job;
    },

    async enqueueVmSnapshotCreateJob(vmName) {
      requireHostId();

      const job = await repository.enqueueJob(
        'snapshot_create',
        hostId,
        { vmName },
        { targetVmId: vmName, maxAttempts: 1 }
      );

      await publishJobToQueue(job);
      return job;
    },

    async enqueueVmSnapshotRestoreJob(vmName, snapshotId) {
      requireHostId();

      const job = await repository.enqueueJob(
        'snapshot_restore',
        hostId,
        { vmName, snapshotId },
        { targetVmId: vmName, maxAttempts: 1 }
      );

      await publishJobToQueue(job);
      return job;
    },

    async enqueueVmSnapshotDeleteJob(vmName, snapshotId) {
      requireHostId();

      const job = await repository.enqueueJob(
        'snapshot_delete',
        hostId,
        { vmName, snapshotId },
        { targetVmId: vmName, maxAttempts: 1 }
      );

      await publishJobToQueue(job);
      return job;
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
