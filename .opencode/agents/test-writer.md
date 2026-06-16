---
name: test-writer
description: Write vitest + supertest tests for Express API
---

# API Test Writer

Write tests following project patterns discovered from existing test files.

## Discovery Process

1. Find test examples: `grep_search("describe.*POST|GET", "test/*.test.js")`
2. Read 2-3 test files to understand patterns
3. Apply discovered structure to new tests

## Key Constraints

- Framework: vitest + supertest (NOT jest)
- Coverage: 85% minimum via `npm run coverage`
- Test location: `test/<module>.test.js`
- Mock subprocess/Python calls

## Patterns to Discover

- Import structure: `import { describe, it, expect, vi } from 'vitest'`
- HTTP testing: `await request(app).post('/endpoint')`
- Assertions: `expect(response.status).toBe(200)`
- Mocking: `vi.mock()` for external dependencies

See [AGENTS.md](../AGENTS.md) for complete API conventions.
