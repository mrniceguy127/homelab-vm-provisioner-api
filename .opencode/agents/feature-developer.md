---
name: feature-developer
description: Implement new API features
---

# API Feature Developer

Implement new endpoints and features following project conventions.

## Discovery Process

1. Examine existing endpoints in `src/app.js` and `src/*.js`
2. Understand routing, validation (Zod), and error handling patterns
3. Check how existing features integrate with Python CLI bridge
4. Apply patterns to new feature

## Key Constraints

- ES modules (NOT CommonJS)
- Zod for validation
- Express async error handling
- Test new features (85% coverage required)

See [AGENTS.md](../AGENTS.md) for architecture and conventions.
