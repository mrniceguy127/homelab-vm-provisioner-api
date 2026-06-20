import app from './app.js';
import { initializeDatabase } from './db.js';
import { initializeNetworkModel } from './network-model.js';
import { initializePrivilegeSupport } from './privileges.js';

const port = Number.parseInt(process.env.PORT || '3001', 10);
const disablePrivilegeSupport = process.env.HLVMP_DISABLE_PRIVILEGES === 'true';

/**
 * Initialize privileged startup state and begin listening for HTTP traffic.
 *
 * @returns {Promise<void>} Resolves after the server is listening.
 */
async function main() {
  if (!disablePrivilegeSupport) {
    await initializePrivilegeSupport();
  }
  await initializeNetworkModel();
  
  // Initialize database connection (optional, will warn if DATABASE_URL not set)
  try {
    await initializeDatabase();
  } catch (error) {
    console.warn('Database initialization failed. Job queue features will be unavailable.');
    console.warn('Error:', error.message);
  }

  app.listen(port, () => {
    console.log(`homelab-vm-provisioner-api listening on port ${port}`);
  });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
