# API Specialist Agents

Specialized agents for the Node.js Express API project (`homelab-vm-provisioner-api`).

## Available Agents

| Agent | Purpose | Testing Framework |
|-------|---------|-------------------|
| test-writer | Write vitest + supertest tests | vitest, supertest |
| coverage-runner | Analyze API coverage (85% target) | vitest coverage |
| feature-developer | Implement API endpoints | Express, Zod |
| defect-fixer | Debug API issues | Node.js debugging |
| doc-writer | Write JSDoc documentation | documentation.js |

## Project Context

- **Framework**: Express.js
- **Testing**: vitest + supertest
- **Validation**: Zod schemas
- **Coverage Target**: 85% minimum
- **Documentation**: JSDoc + documentation.js

## Usage

> **Platform Support**: OpenCode • GitHub Copilot • Cursor • Windsurf • Aider • Continue.dev

**OpenCode**:
```
@homelab-vm-provisioner-api/agents/test-writer.agent.md Write tests for validation.js
```

**GitHub Copilot**:
```
@test-writer Write tests for validation.js
# (when in API directory)
```

**Aider**:
```bash
cd homelab-vm-provisioner-api
aider --read agents/test-writer.agent.md src/validation.js
```

## When to Use

Use these specialist agents when working specifically on the API project. For cross-project work, use the orchestrator agents in the root `agents/` directory.
