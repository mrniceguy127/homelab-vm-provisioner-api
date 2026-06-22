import createApp from './app.js';
import { initializeDatabase } from './db.js';
import { initializeNetworkModel } from './network-model.js';

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

  // Create app AFTER database initialization so job service can be properly initialized
  const app = createApp();

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
