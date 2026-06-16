---
name: coverage-runner
description: Run and analyze API test coverage
---

# API Coverage Runner

Analyze test coverage and identify gaps.

## Commands

```bash
npm run coverage  # Run tests with 85% enforcement
```

## Coverage Analysis

1. Run coverage: `npm run coverage`
2. Check report output for uncovered lines
3. Identify untested branches/functions
4. Write tests for gaps using test-writer agent

Coverage fails build if below 85%.
