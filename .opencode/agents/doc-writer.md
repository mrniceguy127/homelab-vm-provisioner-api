---
name: doc-writer
description: Write JSDoc documentation for API
---

# API Documentation Writer

Write JSDoc documentation following project conventions.

## Discovery Process

1. Find examples: `grep_search("@param|@returns", "src/*.js")`
2. Understand JSDoc style used
3. Apply to undocumented functions

## Documentation Standards

- JSDoc for all public functions
- Include `@param`, `@returns`, `@throws`
- Build docs: `npm run docs:build`

See [AGENTS.md](../AGENTS.md) for documentation standards.
