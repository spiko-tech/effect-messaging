# Changeset Management

Always use changesets for version management:

- Run `pnpm changeset` after making changes that should trigger version bumps
- Use patch bumps for dependency updates and bug fixes (default)
- Use minor bumps for new features
- Use major bumps for breaking changes
- Include specific version numbers in dependency update summaries
- Test builds before creating changesets

Never manually edit package.json versions - always use changesets.