# Copilot Instructions for effect-messaging

## Changeset Workflow

This project uses [Changesets](https://github.com/changesets/changesets) to manage versioning and publishing.

### When to create a changeset

Create a changeset when making changes that should trigger a version bump and be included in the changelog:

- **Patch**: Bug fixes, dependency updates, small improvements
- **Minor**: New features, backwards-compatible changes
- **Major**: Breaking changes

### How to create a changeset

1. Run the changeset command:
   ```bash
   pnpm changeset
   ```

2. Select which packages should be bumped (use arrow keys and spacebar to select)

3. Choose the appropriate bump type:
   - Skip major/minor for dependency updates and bug fixes (defaults to patch)
   - Select minor for new features
   - Select major for breaking changes

4. Write a clear summary that will appear in the changelog

5. Confirm the changeset

### Publishing workflow

1. After merging PRs with changesets, run:
   ```bash
   pnpm changeset-version
   ```
   This updates package.json versions and generates changelogs

2. To publish to npm:
   ```bash
   pnpm changeset-publish
   ```

### Guidelines for Copilot

When working on dependency updates or bug fixes:

1. **Always run `pnpm changeset`** after making changes to create appropriate version bumps
2. Use patch version bumps for dependency updates (the default when no major/minor selected)
3. Include specific version numbers in changeset summaries for dependency updates
4. Test builds and existing tests before creating changesets
5. Don't modify package.json versions directly - let changesets handle this

### Example changeset summary formats

- Dependency updates: `"Upgrade Effect libraries to latest versions (effect ^3.16.13, @effect/platform ^0.88.0, etc.)"`
- Bug fixes: `"Fix memory leak in connection pool"`
- New features: `"Add support for message compression"`
- Breaking changes: `"Remove deprecated publisher API"`