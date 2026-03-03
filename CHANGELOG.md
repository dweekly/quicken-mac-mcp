# Changelog

## 1.0.1

### Fixed

- Server no longer crashes on startup when no `.quicken` bundle is found. The MCP server now starts successfully and returns helpful error messages at tool-call time instead of failing during initialization.
- When multiple `.quicken` bundles exist in `~/Documents`, the server auto-selects the most recently modified one instead of crashing with an ambiguous error.

### Changed

- Database connection is now lazy — deferred to first tool call rather than opening eagerly at startup.
- Tool error handling unified via `safeTool` wrapper, removing per-tool try/catch boilerplate.
- MCP server instructions now guide the calling agent to confirm the auto-detected Quicken file with the user and suggest setting `QUICKEN_DB_PATH` to disambiguate.

## 1.0.0

Initial release.
