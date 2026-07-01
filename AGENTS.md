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
# Set DB_SERVICE_HOST + DB_SERVICE_PASSWORD and QUEUE_* to enable async jobs
```

**Async Jobs Setup** (optional): the API records job metadata in the db-interface microservice
and publishes jobs to RabbitMQ. Configure both to enable async provisioning:

```bash
# 1a. PostgreSQL engine + migrations
cd ../homelab-vm-provisioner-db
./setup && ./start && ./build   # install, start, run migrations

# 1b. db-interface microservice (job metadata, events, resource locks)
cd ../homelab-vm-provisioner-db-interface
./setup && ./start   # port 3002

# Set in API .env
DB_SERVICE_HOST=localhost
DB_SERVICE_PORT=3002
DB_SERVICE_PASSWORD=changeme_db_secret

# 2. RabbitMQ broker (job delivery)
cd ../homelab-vm-provisioner-job-queue
./setup && ./start && ./build   # provisions topology

# Set in API .env
QUEUE_HOST=localhost
QUEUE_PORT=3334
QUEUE_VHOST=provisioner
QUEUE_EXCHANGE=provisioner.jobs
QUEUE_API_USER=provisioner_api
QUEUE_API_PASSWORD=change-me
HOST_ID=local
```

**Note**: When called from parent scripts, this component inherits workspace `.env` variables. This component's `.env` overrides those inherited values. Variables not set here remain inherited from parent.

## API Surface

Main endpoint areas:
- VM lifecycle (provision, start, stop, destroy, clone)
- Network management (users, network groups)
- Snapshots and logs
- Firewall policy updates
- Job dispatch (internal - records metadata in DB microservice, publishes to RabbitMQ)

**Async Job Integration:**
- The API records job metadata via the DB microservice (port 3002) and publishes jobs to RabbitMQ (port 3334)
- Job endpoints are **not exposed** to external API users
- The API uses the job service internally (e.g., for VM provisioning)
- Requires `DB_SERVICE_HOST`, `DB_SERVICE_PORT`, `DB_SERVICE_PASSWORD`, and `QUEUE_*` configuration

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
├── db.js               # Database microservice client
├── job-service.js      # Enqueue jobs (metadata + RabbitMQ publish)
├── rabbitmq-publisher.js # Publish job messages to RabbitMQ
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
