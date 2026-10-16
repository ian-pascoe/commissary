/**
 * Vitest settings shared by the workspace packages that test in plain Node.js (`packages/<name>/vitest.config.ts`:
 * `defineConfig(nodePackageTests("<name>"))`). Conventions: docs/DEVELOPMENT.md, "Tests".
 *
 * No imports: this file sits outside every package, so it cannot resolve their dependencies (`vite`, `vitest`); the
 * objects below are plain Vite/Vitest configuration, typed where `defineConfig` receives them.
 */
/**
 * Loads `*.bin` imports as the `ArrayBuffer` a Workers `Data` module gives (the Worker's bundle and its workerd tests
 * use that module rule), so a package's binary assets (the tokenizer's rank files) behave the same in Node.js. The
 * generated module reads the file when it is imported: Vite never transforms the bytes.
 */
export const binModules = {
  name: "commissary:bin-modules",
  enforce: "pre",
  load(id: string): string | null {
    const file = id.split("?", 1)[0] ?? id;

    if (!file.endsWith(".bin")) return null;

    return [
      'import { readFileSync } from "node:fs";',
      `const bytes = readFileSync(${JSON.stringify(file)});`,
      "export default bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);",
    ].join("\n");
  },
} as const;

/**
 * One Vitest project named after the package: `test/**\/*.test.ts` in Node.js, with {@link binModules}.
 * `passWithNoTests` lets a package with fewer test files than CI's shards (`pnpm test --shard=N/3` reaches every
 * package's run) pass the shards that get none.
 */
export const nodePackageTests = (name: string) => ({
  plugins: [binModules],
  test: {
    name,
    include: ["test/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
  },
});
