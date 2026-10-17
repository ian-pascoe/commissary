/**
 * The workspace's import boundaries, as Oxlint rules (`pnpm lint`). `models-imports` keeps `@commissary/models`
 * (`packages/models/`) a package the Workers reach through its entry points only (#134 "The area package convention",
 * #151):
 *
 * - its sources (`packages/models/src/`) import only their own files, the dependencies its manifest declares and the
 *   runtime modules {@link RUNTIME_MODULES} lists (nothing from `apps/`, no other package's files by a relative path);
 * - the apps (`apps/*`) import Models only as `@commissary/models/api`, `/management` and `/state` (and, in tests,
 *   `/testing`): not its other exports (`/auth-index-key` and `/models-dev` are for the deploy and the catalog sync
 *   script) and never a file of the package by a relative path.
 *
 * Every module specifier counts: imports and re-exports (types too), `import()` calls and `import("…")` types. An
 * `import()` of a computed specifier cannot be checked and is refused in both places.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineRule, eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const APPS = path.join(ROOT, "apps");

const MODELS = path.join(ROOT, "packages/models");

const MODELS_SRC = path.join(MODELS, "src");

const MODELS_PACKAGE = "@commissary/models";

/** The exports of `@commissary/models` an app may import (`./testing` in its tests only: `no-restricted-imports`). */
const APP_ENTRIES: ReadonlySet<string> = new Set(
  ["api", "management", "state", "testing"].map((name) => `${MODELS_PACKAGE}/${name}`),
);

/** Runtime modules Models' sources may import besides the dependencies of its manifest. */
const RUNTIME_MODULES: ReadonlySet<string> = new Set([
  "cloudflare:workers",
  "node:buffer",
  "node:crypto",
  "node:zlib",
]);

const manifest = readFileSync(path.join(MODELS, "package.json"), "utf8");

/** The dependencies `packages/models/package.json` declares. */
const MODELS_DEPENDENCIES: ReadonlySet<string> = new Set(
  Object.keys(
    // SAFETY: a workspace package's manifest is a JSON object whose `dependencies`, when present, maps names to ranges.
    (JSON.parse(manifest) as { readonly dependencies?: Readonly<Record<string, string>> })
      .dependencies ?? {},
  ),
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
        "Keep @commissary/models self-contained and reached by the apps only through its entry points (#151).",
    },
    messages: {
      outsideModels:
        'Models imports "{{specifier}}", which is neither its own file nor a dependency its package.json declares (tools/oxlint/boundaries).',
      computedImport:
        "An import() of a computed specifier cannot be checked against the Models boundary: import a string literal.",
      notAnEntry:
        '"{{specifier}}" is not an entry point of Models for the apps: import @commissary/models/api, /management or /state (tests also /testing).',
      intoModels:
        '"{{specifier}}" reaches into packages/models by a path: import its entry points (@commissary/models/api, /management, /state).',
    },
  },
  create(context) {
    const filename = context.filename;
    const inModels = isInside(MODELS_SRC, filename);

    if (!inModels && !isInside(APPS, filename)) return {};

    const check = (source: ESTree.Node, specifier: string) => {
      const target = resolved(filename, specifier);

      if (inModels) {
        const allowed =
          target === undefined
            ? MODELS_DEPENDENCIES.has(packageOf(specifier)) || RUNTIME_MODULES.has(specifier)
            : isInside(MODELS_SRC, target);

        if (!allowed)
          context.report({ node: source, messageId: "outsideModels", data: { specifier } });
      } else if (target !== undefined) {
        if (isInside(MODELS, target))
          context.report({ node: source, messageId: "intoModels", data: { specifier } });
      } else if (packageOf(specifier) === MODELS_PACKAGE && !APP_ENTRIES.has(specifier))
        context.report({ node: source, messageId: "notAnEntry", data: { specifier } });
    };

    return {
      ImportDeclaration: (node) => check(node.source, node.source.value),
      ExportNamedDeclaration: (node) => {
        if (node.source !== null) check(node.source, node.source.value);
      },
      ExportAllDeclaration: (node) => check(node.source, node.source.value),
      TSImportType: (node) => check(node.source, node.source.value),
      TSExternalModuleReference: (node) => check(node.expression, node.expression.value),
      ImportExpression: (node) => {
        const source = node.source;

        if (source.type === "Literal" && typeof source.value === "string")
          check(source, source.value);
        else if (source.type === "TemplateLiteral" && source.expressions.length === 0)
          check(source, source.quasis[0]?.value.cooked ?? "");
        else context.report({ node: source, messageId: "computedImport" });
      },
    };
  },
});

/** Import boundaries between the workspace's areas, apps and packages. */
export default eslintCompatPlugin({
  meta: { name: "boundaries" },
  rules: { "models-imports": modelsImportsRule },
});
