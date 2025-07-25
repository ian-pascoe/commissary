# AGENTS.md

## Commands

- **Build:** `bun run build` (includes type checking via tsgo)
- **Lint:** `bun run lint` (check), `bun run lint:fix` (fix)
- **Format:** `bun run format` (using Biome)
- **Type check:** `bun run type-check`
- **Test:** `bun run test` (runs all tests via vitest)
- **Dev:** `bun run dev` (development server)

## Code Style

- **Formatter:** Biome with double quotes, space indentation
- **Imports:** Use ~ alias for src/, organize imports automatically
- **Types:** Prefer `type` over `interface`, explicit types for props/returns
- **Naming:** camelCase for variables/functions, PascalCase for components/types
- **Components:** Use function declarations, destructure props with types
- **Error handling:** Use try/catch for async operations, throw descriptive errors
- **File structure:** Group related imports, export default at bottom
- **Utilities:** Use clsx/twMerge via cn() helper for className composition

## Notes

- This is a Tauri app with React frontend and Hono backend
- Uses Drizzle ORM with local/remote database configs
- No existing cursor rules or copilot instructions found
