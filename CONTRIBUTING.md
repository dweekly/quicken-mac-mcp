# Contributing to quicken-mac-mcp

Thanks for your interest in contributing! This project is a read-only MCP server for Quicken For Mac data.

## Getting started

```bash
git clone https://github.com/dweekly/quicken-mac-mcp.git
cd quicken-mac-mcp
npm install
```

## Development

```bash
npm test          # run tests (vitest)
npm run lint      # eslint
npm run format    # prettier
npm run dev       # run server locally via tsx
```

## After a Quicken update

Quicken changes its database layout between releases. With Quicken open on a data file:

```bash
QUICKEN_DB_PATH=~/Documents/YourFile.quicken/data npm run schema:check    # does docs/schema.md still match?
QUICKEN_DB_PATH=~/Documents/YourFile.quicken/data npm run schema:refresh  # rewrite the generated parts
```

`schema:refresh` rewrites every `CREATE TABLE` block, the index list, and the capture line in `docs/schema.md`. It lists what it cannot write for you: new tables and entities that need a section, and documented ones that no longer exist. `npm test` runs the same check against a live file when one is available, so drift fails the live suite. A file from an older Quicken than the capture is reported as skipped, not as drift. Then add the new layout to `QUICKEN_LAYOUTS` in `src/__tests__/fixtures/quicken.ts` if the change affects anything the server or skill touches.

## Submitting changes

1. Fork the repo and create a branch from `main`.
2. Make your changes. Add tests if you're adding new functionality.
3. Run `npm test` and `npm run lint` to make sure everything passes.
4. Open a pull request with a clear description of what you changed and why.

## Versioning

Follow semantic versioning from the perspective of tool and CLI users:

- Patch: backward-compatible fixes and documentation changes that do not alter
  database selection or tool-output semantics.
- Minor: new functionality or user-visible changes to tool output, filtering,
  defaults, or database selection.
- Major: incompatible tool, CLI, configuration, or package API changes.

Use `npm version` for a release bump. Its lifecycle hook synchronizes
`manifest.json`, `server.json`, and the Claude plugin metadata; the test suite
guards those versions against future drift.

## Reporting bugs

Open a [GitHub issue](https://github.com/dweekly/quicken-mac-mcp/issues) with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your Node.js version and OS

## Code style

- TypeScript, formatted with Prettier
- No changes to Quicken data — the server must remain strictly read-only

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
