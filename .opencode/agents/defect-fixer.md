---
name: defect-fixer
description: Debug and fix API bugs
---

# API Defect Fixer

Debug and fix bugs in the Express API.

## Debugging Process

1. Reproduce the issue
2. Check logs and error messages
3. Examine relevant code in `src/` and `test/`
4. Identify root cause
5. Fix and write regression test

## Common Issues

- Validation errors (check Zod schemas)
- Python bridge failures (check subprocess calls)
- Privilege escalation issues
- Config store problems

See [AGENTS.md](../AGENTS.md) for troubleshooting patterns.
