/**
 * Artifact path resolution for API service.
 * 
 * The API is a DB-backed microservice that:
 * - Stores VM definitions in PostgreSQL
 * - Enqueues jobs for the worker
 * - Queries runtime state from the database
 * 
 * The API does NOT:
 * - Call provisioner directly
 * - Manage data directories
 * - Access file system artifacts
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const apiRoot = path.resolve(__dirname, '..');
