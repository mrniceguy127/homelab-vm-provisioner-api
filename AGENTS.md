# Homelab VM Provisioner API

Express.js REST API that wraps the Python CLI for VM provisioning with privilege management and configuration storage.

## Architecture

### Core Modules
- **app.js**: Express app setup, route registration, error handling
- **server.js**: HTTP server initialization
- **provisioner.js**: Python CLI subprocess management
- **validation.js**: Zod schemas for request validation
- **config-store.js**: YAML configuration file management
- **network-model.js**: Network configuration validation and CIDR math
- **privileges.js**: Privilege escalation checks

### API Routes
```
POST /api/provision       # Create new VM
POST /api/reconcile       # Sync VMs to desired state  
GET  /api/config          # Retrieve stored configuration
POST /api/config          # Save configuration
```

## Build and Test

### Commands
```bash
npm test          # Run all tests (vitest)
npm run coverage  # Generate coverage report (85% minimum)
npm start         # Start production server
npm run docs:build # Build JSDoc documentation
npm run build     # Run coverage + docs (for CI/CD)
```

### Test Files
- `test/app.test.js`: HTTP endpoint tests (supertest)
- `test/validation.test.js`: Schema validation tests
- `test/network-model.test.js`: CIDR and network logic tests

### Python Bridge
Located in `bridge/hlvmp_bridge.py` - provides JSON-based interface to Python CLI.

## Code Style

### General
- ES modules (`import`/`export`, `type: "module"`)
- Async/await for all async operations
- No default exports, use named exports

### Express
- Middleware: express.json() for parsing
- Error handling: centralized error middleware
- Routes: Return JSON with appropriate HTTP status codes

### Testing
- Vitest with supertest for HTTP testing
- Mock subprocess calls to Python CLI
- Test both success and error paths

## Testing Conventions

### What to Test
- **Request validation**: Invalid inputs return 400
- **Subprocess communication**: Python bridge called correctly
- **Error handling**: Failed operations return 500
- **Config storage**: YAML read/write operations
- **Network logic**: CIDR calculations, IP validation

### Test Structure
```javascript
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';

describe('POST /api/provision', () => {
  it('should validate required fields', async () => {
    const response = await request(app)
      .post('/api/provision')
      .send({});
    expect(response.status).toBe(400);
  });
});
```

### Coverage
- Aim for 85%+ line and branch coverage
- Focus on edge cases: empty inputs, subprocess failures, file system errors
- Use `vi.mock()` to isolate units from dependencies

## Documentation

### JSDoc Style
```javascript
/**
 * Provision a new VM with the given configuration.
 * @param {Object} config - VM configuration object
 * @param {string} config.name - VM name
 * @param {string} config.template - OS template name
 * @returns {Promise<Object>} Provisioning result with VM details
 * @throws {Error} If provisioning fails
 */
```

### Build Documentation
```bash
npm run docs:build
# Output: docs/_build/html/index.html
```

### What to Document
- Exported functions and classes
- Complex algorithms (especially in network-model.js)
- API endpoint contracts
- Error conditions

## Common Patterns

### Subprocess Management
```javascript
import { spawn } from 'child_process';

// Always use bridge script for Python communication
const process = spawn('python3', ['bridge/hlvmp_bridge.py', 'provision']);
```

### Error Responses
```javascript
// Client errors (400)
res.status(400).json({ error: 'Invalid configuration', details: zodError });

// Server errors (500)
res.status(500).json({ error: 'Provisioning failed', message: error.message });
```

### Configuration Storage
```javascript
import { loadConfig, saveConfig } from './config-store.js';

// YAML stored at configured path, defaults to vmctl.yaml
const config = await loadConfig(configPath);
await saveConfig(configPath, updatedConfig);
```

## Key Gotchas

### Python Bridge
- Bridge script expects JSON on stdin, returns JSON on stdout
- Always handle stderr for Python errors
- Subprocess must complete before response is sent

### Privilege Management
- API runs as non-root user
- Python CLI requires root for libvirt operations
- Use `privileges.js` to check/request elevation

### File System
- Config files use YAML format (js-yaml library)
- Paths may be relative or absolute
- Handle file not found gracefully (create with defaults)

### Validation
- Use Zod schemas defined in `validation.js`
- Validate early (in route handler)
- Return detailed error messages for debugging

### Testing
- Mock child_process for Python bridge tests
- Mock fs/promises for config-store tests
- Use supertest for integration tests (full request/response cycle)

## Dependencies

### Production
- **express**: Web framework
- **js-yaml**: YAML parsing/serialization
- **zod**: Schema validation

### Development
- **vitest**: Test runner and assertions
- **supertest**: HTTP testing library
- **@vitest/coverage-v8**: Code coverage
- **documentation**: JSDoc HTML generator

## Development Workflow

1. **Add endpoint**: Define route in app.js, add validation schema
2. **Write tests**: Test success and error cases with supertest
3. **Implement**: Call Python bridge, handle errors, return JSON
4. **Run coverage**: `npm run coverage` (must hit 85%)
5. **Update docs**: Add JSDoc comments, run `npm run docs:build`
6. **Integration test**: Test with actual Python CLI in development

## Specialized Agents

For common tasks, use the specialized agents in `../agents/`:
- **test-writer**: Generate tests following API patterns
- **coverage-runner**: Analyze coverage gaps
- **feature-developer**: Implement new endpoints
- **defect-fixer**: Debug API issues
- **doc-writer**: Update API documentation

See `../agents/README.md` for usage across different platforms.

## Related Documentation

- Parent: `../AGENTS.md` (monorepo overview)
- Python CLI: `homelab-vm-provisioner/AGENTS.md`
- Client: `../homelab-vm-provisioner-client/AGENTS.md`
