import app from './app.js';
import { initializeNetworkModel } from './network-model.js';
import { initializePrivilegeSupport } from './privileges.js';

const port = Number.parseInt(process.env.PORT || '3000', 10);

/**
 * Initialize privileged startup state and begin listening for HTTP traffic.
 *
 * @returns {Promise<void>} Resolves after the server is listening.
 */
async function main() {
  await initializePrivilegeSupport();
  await initializeNetworkModel();

  app.listen(port, () => {
    console.log(`homelab-vm-provisioner-api listening on port ${port}`);
  });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
