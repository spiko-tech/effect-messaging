# Development Standards

## Dependencies

When updating dependencies:
- Update root package.json and all relevant package-specific package.json files
- Run `pnpm changeset` to create version bump
- Use patch version for dependency updates
- Include specific version ranges in changeset summary

## Effect Libraries

This project uses Effect ecosystem libraries:
- effect (core library)
- @effect/platform (platform abstractions)
- @effect/vitest (testing utilities)
- @effect/build-utils (build tooling)

Keep these in sync across all packages and maintain compatibility.