/**
 * RabbitMQ publisher for job messages
 * 
 * Publishes job messages to RabbitMQ exchange with routing based on target host ID.
 * Connection details are built from component environment variables.
 */

import amqp from 'amqplib';

/**
 * Create a RabbitMQ publisher
 * 
 * @param {object} options - Publisher options
 * @param {string} options.host - RabbitMQ host
 * @param {number} options.port - RabbitMQ port
 * @param {string} options.vhost - RabbitMQ vhost
 * @param {string} options.user - Publisher username
 * @param {string} options.password - Publisher password
 * @param {string} options.exchange - Exchange name
 * @param {string} options.routingKeyPrefix - Routing key prefix (e.g., 'host')
 * @param {object} options.logger - Logger instance (default: console)
 * @returns {Promise<object>} Publisher instance
 */
export async function createRabbitMqPublisher({
  host,
  port,
  vhost,
  user,
  password,
  exchange,
  routingKeyPrefix,
  logger = console
}) {
  // Build connection URL from components
  const url = `amqp://${user}:${password}@${host}:${port}/${encodeURIComponent(vhost)}`;
  
  let connection = null;
  let channel = null;
  
  /**
   * Connect to RabbitMQ
   */
  async function connect() {
    try {
      connection = await amqp.connect(url);
      channel = await connection.createChannel();
      
      // Confirm exchange exists (do not create - provisioned by queue subproject)
      await channel.checkExchange(exchange);
      
      // Handle connection errors
      connection.on('error', (err) => {
        logger.error('RabbitMQ connection error:', err);
      });
      
      connection.on('close', () => {
        logger.warn('RabbitMQ connection closed');
      });
      
      logger.info('RabbitMQ publisher connected');
    } catch (error) {
      logger.error('Failed to connect to RabbitMQ:', error);
      throw error;
    }
  }
  
  /**
   * Publish a job message to RabbitMQ
   * 
   * @param {object} job - Job details
   * @param {string|number} job.job_id - Job ID
   * @param {string} job.job_type - Job type
   * @param {string} job.target_host_id - Target host ID
   * @returns {Promise<boolean>} True if published successfully
   */
  async function publishJob({ job_id, job_type, target_host_id }) {
    if (!channel) {
      throw new Error('Publisher not connected');
    }
    
    const routingKey = `${routingKeyPrefix}.${target_host_id}`;
    const message = {
      job_id: String(job_id),
      job_type,
      target_host_id
    };
    
    const messageBuffer = Buffer.from(JSON.stringify(message));
    
    try {
      const result = channel.publish(
        exchange,
        routingKey,
        messageBuffer,
        {
          persistent: true,
          contentType: 'application/json',
          timestamp: Date.now()
        }
      );
      
      if (!result) {
        throw new Error('Publish returned false (channel buffer full)');
      }
      
      logger.info(`Published job ${job_id} to ${routingKey}`);
      return true;
    } catch (error) {
      logger.error(`Failed to publish job ${job_id}:`, error);
      throw error;
    }
  }
  
  /**
   * Close publisher connection
   */
  async function close() {
    try {
      if (channel) {
        await channel.close();
        channel = null;
      }
      if (connection) {
        await connection.close();
        connection = null;
      }
      logger.info('RabbitMQ publisher closed');
    } catch (error) {
      logger.error('Error closing RabbitMQ publisher:', error);
    }
  }
  
  // Connect on creation
  await connect();
  
  return {
    publishJob,
    close
  };
}

/**
 * Create a RabbitMQ publisher from environment variables
 * 
 * Reads configuration from:
 * - QUEUE_HOST
 * - QUEUE_PORT
 * - QUEUE_VHOST
 * - QUEUE_API_USER
 * - QUEUE_API_PASSWORD
 * - QUEUE_EXCHANGE
 * - QUEUE_ROUTING_KEY_PREFIX
 * 
 * @param {object} options - Options
 * @param {object} options.logger - Logger instance (default: console)
 * @returns {Promise<object>} Publisher instance
 * @throws {Error} If required environment variables are missing
 */
export async function createRabbitMqPublisherFromEnv({ logger = console } = {}) {
  const required = {
    host: process.env.QUEUE_HOST,
    port: process.env.QUEUE_PORT,
    vhost: process.env.QUEUE_VHOST,
    user: process.env.QUEUE_API_USER,
    password: process.env.QUEUE_API_PASSWORD,
    exchange: process.env.QUEUE_EXCHANGE,
    routingKeyPrefix: process.env.QUEUE_ROUTING_KEY_PREFIX
  };
  
  const missing = Object.entries(required)
    .filter(([_, value]) => !value)
    .map(([key]) => key.toUpperCase());
  
  if (missing.length > 0) {
    throw new Error(`Missing required RabbitMQ environment variables: ${missing.join(', ')}`);
  }
  
  return createRabbitMqPublisher({
    host: required.host,
    port: Number(required.port),
    vhost: required.vhost,
    user: required.user,
    password: required.password,
    exchange: required.exchange,
    routingKeyPrefix: required.routingKeyPrefix,
    logger
  });
}
