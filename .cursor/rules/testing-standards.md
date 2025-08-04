# Testing Standards

## Pre-change Validation
Before any changes:
- Run `pnpm build` to ensure code compiles
- Run `pnpm test` to ensure tests pass  
- Run `pnpm lint` to check code style

## Test Writing Standards
- **Always use `it.effect`** for tests with `@effect/vitest` when working with Effect-based code
- Use proper Effect composition patterns in tests
- Prefer integration tests that verify full stack functionality
- Use `vi.fn()` for mocking and verification in tests