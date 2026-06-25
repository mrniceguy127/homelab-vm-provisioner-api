/**
 * Internal worker API endpoints
 * 
 * These endpoints are used by workers to report job status and results.
 * They are NOT exposed to external users.
 */

import express from 'express';

/**
 * Create internal worker router
 * 
 * @param {object} options - Router options
 * @param {object} options.repository - Job repository client
 * @param {string|null} options.hostId - API host ID for validation (reserved for future use)
 * @param {object} options.logger - Logger instance
 * @returns {express.Router} Express router
 */
export function createInternalWorkerRouter({ repository, hostId: _hostId, logger = console }) {
  const router = express.Router();
  
  /**
   * Validate job exists and target host matches
   */
  async function validateJobAccess(req, res, next) {
    const jobId = Number(req.params.jobId);
    
    if (isNaN(jobId)) {
      return res.status(400).json({ error: 'Invalid job ID' });
    }
    
    const job = await repository.getJob(jobId);
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    // Validate target host matches (if configured)
    const workerHostId = req.body.worker_host_id || req.body.host_id;
    if (workerHostId && job.target_host_id !== workerHostId) {
      logger.warn(`Worker host mismatch: job targets ${job.target_host_id}, worker reports ${workerHostId}`);
      return res.status(403).json({ error: 'Worker host ID does not match job target host' });
    }
    
    req.job = job;
    next();
  }
  
  /**
   * GET /internal/worker/jobs/:jobId
   * 
   * Fetch job details for worker
   */
  router.get('/jobs/:jobId', validateJobAccess, async (req, res) => {
    try {
      res.json(req.job);
    } catch (error) {
      logger.error('Error fetching job:', error);
      res.status(500).json({ error: 'Failed to fetch job' });
    }
  });
  
  /**
   * POST /internal/worker/jobs/:jobId/start
   * 
   * Mark job as running
   */
  router.post('/jobs/:jobId/start', validateJobAccess, async (req, res) => {
    try {
      const { worker_id, claimed_by } = req.body;
      
      // Validate status transition
      if (req.job.status !== 'queued' && req.job.status !== 'published') {
        return res.status(409).json({ error: `Cannot start job in status ${req.job.status}` });
      }
      
      await repository.updateJobStatus(req.job.id, 'running', {
        claimed_by: claimed_by || worker_id,
        started_at: new Date()
      });
      
      await repository.appendJobEvent(
        req.job.id,
        'info',
        `Worker ${worker_id || claimed_by || 'unknown'} started processing`,
        null
      );
      
      res.json({ success: true });
    } catch (error) {
      logger.error('Error starting job:', error);
      res.status(500).json({ error: 'Failed to start job' });
    }
  });
  
  /**
   * POST /internal/worker/jobs/:jobId/heartbeat
   * 
   * Update worker heartbeat timestamp
   */
  router.post('/jobs/:jobId/heartbeat', validateJobAccess, async (req, res) => {
    try {
      await repository.updateJobStatus(req.job.id, req.job.status, {
        last_heartbeat_at: new Date()
      });
      
      res.json({ success: true });
    } catch (error) {
      logger.error('Error updating heartbeat:', error);
      res.status(500).json({ error: 'Failed to update heartbeat' });
    }
  });
  
  /**
   * POST /internal/worker/jobs/:jobId/succeed
   * 
   * Mark job as succeeded
   */
  router.post('/jobs/:jobId/succeed', validateJobAccess, async (req, res) => {
    try {
      const { result } = req.body;
      
      // Validate status transition
      if (req.job.status !== 'running') {
        return res.status(409).json({ error: `Cannot succeed job in status ${req.job.status}` });
      }
      
      await repository.updateJobStatus(req.job.id, 'succeeded', {
        result,
        finished_at: new Date()
      });
      
      await repository.appendJobEvent(
        req.job.id,
        'info',
        'Job completed successfully',
        { result }
      );
      
      res.json({ success: true });
    } catch (error) {
      logger.error('Error succeeding job:', error);
      res.status(500).json({ error: 'Failed to mark job as succeeded' });
    }
  });
  
  /**
   * POST /internal/worker/jobs/:jobId/fail
   * 
   * Mark job as failed
   */
  router.post('/jobs/:jobId/fail', validateJobAccess, async (req, res) => {
    try {
      const { error: errorMessage, retryable = false } = req.body;
      
      // Validate status transition
      if (req.job.status !== 'running') {
        return res.status(409).json({ error: `Cannot fail job in status ${req.job.status}` });
      }
      
      const status = retryable ? 'retryable_failed' : 'failed';
      
      await repository.updateJobStatus(req.job.id, status, {
        error: errorMessage,
        finished_at: new Date(),
        attempts: req.job.attempts + 1
      });
      
      await repository.appendJobEvent(
        req.job.id,
        'error',
        `Job failed: ${errorMessage}`,
        { retryable }
      );
      
      res.json({ success: true });
    } catch (error) {
      logger.error('Error failing job:', error);
      res.status(500).json({ error: 'Failed to mark job as failed' });
    }
  });
  
  /**
   * POST /internal/worker/jobs/:jobId/cleanup-required
   * 
   * Mark job as requiring cleanup
   */
  router.post('/jobs/:jobId/cleanup-required', validateJobAccess, async (req, res) => {
    try {
      const { cleanup_context } = req.body;
      
      await repository.updateJobStatus(req.job.id, 'cleanup_required', {
        cleanup_context,
        finished_at: new Date()
      });
      
      await repository.appendJobEvent(
        req.job.id,
        'warning',
        'Job completed but cleanup is required',
        { cleanup_context }
      );
      
      res.json({ success: true });
    } catch (error) {
      logger.error('Error marking job for cleanup:', error);
      res.status(500).json({ error: 'Failed to mark job for cleanup' });
    }
  });
  
  return router;
}
