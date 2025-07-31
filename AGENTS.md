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
- **Schemas:** Use `zod` to create schemas. All schemas live in the `./src/schemas` directory.
- **Types:** Prefer `type` over `interface`, explicit types for props, inferred types for returns where possible.
- **Naming:** camelCase for variables/functions, PascalCase for components/types, kebab-case for file and directory names.
- **Components:** Use function declarations, destructure props with types
- **Error handling:** Use try/catch for async operations, throw descriptive errors
- **File structure:** Group related imports, export default at bottom
- **Utilities:** Use clsx/twMerge via cn() helper for className composition

## Data Management & Forms

### TanStack Query
- **Mutations:** Use `useMutation` for server state mutations (create, update, delete operations)
- **Queries:** Use `useQuery` for data fetching with proper query keys from `~/lib/query-keys`
- **Error handling:** Handle errors in mutation callbacks, display user-friendly error messages
- **Loading states:** Use `isPending` and `isSubmitting` for loading indicators
- **Query invalidation:** Invalidate relevant queries after successful mutations using `queryClient.invalidateQueries()`

### TanStack Form
- **Form management:** Use `useForm` hook from `~/hooks/use-form` for all form handling
- **Validation:** Use zod schemas for `validators.onChange` option for real-time validation
- **Form fields:** Use `form.AppField` pattern for consistent field rendering with labels and error display
- **Form submission:** Use `onSubmit` callback in useForm options, call `form.handleSubmit()` in form onSubmit
- **Form state:** Use `form.Subscribe` to access form state (isSubmitting, canSubmit, etc.)
- **Field pattern:**
  ```tsx
  <form.AppField name="fieldName">
    {(field) => (
      <div className="space-y-2">
        <field.Label>Field Label</field.Label>
        <field.Input 
          value={field.state.value}
          onChange={(e) => field.setValue(e.target.value)}
        />
        <field.FieldError />
      </div>
    )}
  </form.AppField>
  ```

### Integration Pattern
- **Form + Mutation:** Combine useForm with useMutation for robust form handling
- **Schema-first:** Define zod schemas in `~/schemas/` directory first, then use for both validation and TypeScript types
- **Error display:** Show mutation errors above form, field validation errors below fields
- **Loading states:** Disable form inputs during mutation.isPending
- **Type safety:** Use zod inferred types for form data and mutation inputs

## Notes

- This is a Tauri app with React frontend and Hono backend
- Uses Drizzle ORM with local/remote database configs
- No existing cursor rules or copilot instructions found
