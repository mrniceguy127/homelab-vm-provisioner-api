import createApp from './app.js';
import { initializeDatabase } from './db.js';
import { initializeNetworkModel } from './network-model.js';
import { createRabbitMqPublisherFromEnv } from './rabbitmq-publisher.js';

const port = Number.parseInt(process.env.PORT || '3001', 10);

/**
 * Initialize startup state and begin listening for HTTP traffic.
 *
 * @returns {Promise<void>} Resolves after the server is listening.
 */
async function main() {
  // Initialize database connection (optional, will warn if not available)
  try {
    await initializeDatabase();
  } catch (error) {
    console.warn('Database initialization failed. Job queue features will be unavailable.');
    console.warn('Error:', error.message);
  }

  // Initialize network model (optional, requires database)
  try {
    await initializeNetworkModel();
  } catch (error) {
    console.warn('Network model initialization failed. Using defaults.');
    console.warn('Error:', error.message);
  }

  // Initialize RabbitMQ publisher (optional)
  let rabbitMqPublisher = null;
  if (process.env.QUEUE_HOST && process.env.QUEUE_API_USER) {
    try {
      rabbitMqPublisher = await createRabbitMqPublisherFromEnv();
      console.log('RabbitMQ publisher initialized successfully');
    } catch (error) {
      console.warn('Failed to initialize RabbitMQ publisher:', error.message);
      console.warn('Job queue will fall back to socket notification');
    }
  } else {
    console.log('RabbitMQ not configured (QUEUE_HOST or QUEUE_API_USER missing)');
  }

  // Create app AFTER database initialization so job service can be properly initialized
  const app = createApp(undefined, { rabbitMqPublisher });

  app.listen(port, () => {
    console.log(`homelab-vm-provisioner-api listening on port ${port}`);
  });
}

export { main };

// Only run if this module is the main entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
