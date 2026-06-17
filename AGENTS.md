# Homelab VM Provisioner API

Express.js REST API wrapping Python CLI for VM provisioning with privilege management.

## Quick Start

```bash
npm test && npm run coverage  # Lint + test with 80% minimum
npm run lint                     # ESLint only
npm start                     # Production server
npm run docs:build            # Build JSDoc docs
```

## Configuration

Copy `.env.example` to `.env` and customize:

```bash
cp .env.example .env
# Edit .env to set API_PORT, PROVISIONER_VENV_DIR, HLVMP_* variables
```

**Note**: When called from parent scripts, this component inherits workspace `.env` variables. This component's `.env` overrides those inherited values. Variables not set here remain inherited from parent.

## API Surface

Main endpoint areas:
- VM lifecycle (provision, start, stop, destroy, clone)
- Network management (users, network groups)
- Snapshots and logs
- Firewall policy updates

Generated API docs and source route/schema comments are the source of truth for exact routes, request/response bodies, validation rules, status codes, and examples.

## Documentation Sources

Before editing API docs or endpoint behavior:
- Inspect the API project's docs configuration and existing doc comments.
- Follow the repo's existing documentation layout.
- Run `npm run docs:build` to build JSDoc documentation.
- Do not duplicate full endpoint documentation in `AGENTS.md`.

## Project Structure

```
src/
├── app.js              # Express routes & middleware
├── server.js           # HTTP server
├── provisioner.js      # Python CLI subprocess
├── validation.js       # Zod schemas
├── config-store.js     # YAML config management
├── network-model.js    # Network validation & CIDR
└── privileges.js       # Privilege checks

test/
├── app.test.js         # HTTP endpoint tests
├── validation.test.js  # Schema tests
└── network-model.test.js # Network logic tests

bridge/
└── hlvmp_bridge.py     # Python CLI JSON interface
```

## Code Style

**Framework**: Express + ES modules  
**Testing**: vitest + supertest  
**Validation**: Zod schemas  
**Coverage**: 80% minimum (enforced)  
**Linting**: ESLint (required before tests run)  
**Docs**: JSDoc + documentation.js

**Key Patterns**:
- Async/await for all async operations
- Named exports only (no defaults)
- Centralized error middleware
- Mock subprocess calls in tests

## AI Agents

Project-specific OpenCode agents live in `.opencode/agents/`.

### Usage

```bash
# Direct invocation (recommended)
@.opencode/agents/test-writer.md Write tests for validation.js
@.opencode/agents/coverage-runner.md Check coverage
```

### Available Agents

- **test-writer.md** - vitest + supertest patterns
- **coverage-runner.md** - 80% enforcement
- **feature-developer.md** - Express + Zod patterns
- **defect-fixer.md** - Node.js debugging
- **doc-writer.md** - JSDoc patterns

## Testing Essentials

**Framework**: vitest (NOT jest)  
**HTTP Testing**: supertest for endpoint tests  
**Mocking**: Mock Python bridge subprocess calls  
**Coverage Target**: 80% minimum

**Pattern Discovery**: Before writing tests, inspect nearby existing tests and follow their style.

## Common Issues

- Missing async/await in routes
- Unhandled errors (use try/catch + error middleware)
- Validation schema gaps
- Subprocess communication errors
