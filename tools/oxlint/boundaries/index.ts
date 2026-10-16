/**
 * The workspace's import boundaries, as Oxlint rules (`pnpm lint`). `models-imports` keeps the Models folder
 * (`apps/app/src/models/`) ready to become `@commissary/models` (#150, #151):
 *
 * - a file in the folder imports only files of the folder, the workspace packages (`@commissary/*` under `packages/`)
 *   and the modules {@link MODELS_MODULES} lists: never the app's own code, its API-Worker code (`src/api/`) or the
 *   Worker entry;
 * - any other file of `apps/app/src/` imports Models only through its entry modules, which match the package's future
 *   exports (#134 "The area package convention"): `api.ts`, `management.ts` and `state.ts`.
 *
 * Every module specifier counts: imports and re-exports (types too), `import()` calls and `import("…")` types.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineRule, eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const APP_SRC = path.join(ROOT, "apps/app/src");

const MODELS = path.join(APP_SRC, "models");

/** The entry modules code outside the folder may import. */
const MODELS_ENTRIES = ["api.ts", "management.ts", "state.ts"].map((name) =>
  path.join(MODELS, name),
);

/** What Models may import besides the workspace packages: its third-party dependencies once it is a package. */
const MODELS_MODULES = new Set([
  "effect",
  "cloudflare:workers",
  "fzstd",
  "yaml",
  "node:buffer",
  "node:crypto",
  "node:zlib",
]);

/** The names of the workspace packages (`packages/*`); an app is never one of them. */
const PACKAGES = new Set(
  readdirSync(path.join(ROOT, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifest = readFileSync(
        path.join(ROOT, "packages", entry.name, "package.json"),
        "utf8",
      );

      // SAFETY: a workspace package's manifest is a JSON object with a string `name`.
      return (JSON.parse(manifest) as { readonly name: string }).name;
    }),
);

const isInside = (dir: string, file: string): boolean => {
  const relative = path.relative(dir, file);

  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

/** The package a bare specifier names: `@scope/name` or `name`. */
const packageOf = (specifier: string): string => {
  const parts = specifier.split("/");

  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
};

const allowedInModels = (specifier: string): boolean =>
  PACKAGES.has(packageOf(specifier)) ||
  MODELS_MODULES.has(specifier) ||
  MODELS_MODULES.has(packageOf(specifier));

/** The file a relative specifier names (without a query such as `?raw`); `undefined` for a bare one. */
const resolved = (filename: string, specifier: string): string | undefined =>
  specifier.startsWith(".")
    ? path.resolve(path.dirname(filename), specifier.split("?")[0] ?? specifier)
    : undefined;

const modelsImportsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep the Models folder self-contained and reached only through its entry modules (#150).",
    },
    messages: {
      outsideModels:
        'Models imports "{{specifier}}", which is outside the folder: Models may import only its own files, the workspace packages and its listed modules (tools/oxlint/boundaries).',
      insideModels:
        '"{{specifier}}" reaches inside Models: import its entry modules (models/api.ts, models/management.ts, models/state.ts) instead.',
    },
  },
  create(context) {
    const filename = context.filename;

    if (!isInside(APP_SRC, filename)) return {};
    const inModels = isInside(MODELS, filename);

    const check = (source: ESTree.StringLiteral | null) => {
      if (source === null) return;
      const specifier = source.value;
      const target = resolved(filename, specifier);

      if (inModels) {
        const allowed =
          target === undefined ? allowedInModels(specifier) : isInside(MODELS, target);

        if (!allowed)
          context.report({ node: source, messageId: "outsideModels", data: { specifier } });
      } else if (
        target !== undefined &&
        isInside(MODELS, target) &&
        !MODELS_ENTRIES.includes(target)
      )
        context.report({ node: source, messageId: "insideModels", data: { specifier } });
    };

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      TSImportType: (node) => check(node.source),
      TSExternalModuleReference: (node) => check(node.expression),
      ImportExpression: (node) => {
        if (node.source.type === "Literal" && typeof node.source.value === "string")
          check(node.source);
      },
    };
  },
});

/** Import boundaries between the workspace's areas, apps and packages. */
export default eslintCompatPlugin({
  meta: { name: "boundaries" },
  rules: { "models-imports": modelsImportsRule },
});
