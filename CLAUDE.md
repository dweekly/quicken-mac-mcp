# CLAUDE.md — Developer Guidelines

Development reference for `quicken-mac-mcp`.

## Build & Run Commands

- **Build Project**: `npm run build` (compiles TS to `dist/`)
- **Run Developer CLI/Server**: `npx tsx src/index.ts [command] [args]` (or `npm run dev -- [command] [args]`)
- **Start Compiled Server**: `npm start`
- **Run Tests**: `npm test` (runs all unit/integration tests with Vitest)
- **Watch Tests**: `npm run test:watch`
- **Lint Code**: `npm run lint`
- **Format Code**: `npm run format`

## Code Guidelines

- **Style**: Use standard TypeScript with Prettier configuration (semicolons, single quotes, double spaces).
- **Environment**: ESM modules are used throughout (`"type": "module"` in `package.json`). All relative imports must end with `.js` extensions (e.g. `import { x } from './db.js'`).
- **Database Safety**: All Quicken database access must be read-only (`{ readonly: true }`). Never perform write queries on the decrypted SQLite database.
- **Error Handling**: Use `sanitizeError` or safe wrappers to avoid leaking absolute paths of personal data files in logs or tool responses.
- **Naming Conventions**:
  - MCP Tool subcommands in CLI: accept snake_case, kebab-case, or camelCase, but internal properties map to standard tool arguments.
  - SQLite columns are mapped to standard camelCase or snake_case attributes.
