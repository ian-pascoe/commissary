// `@commissary/translation`'s tokenizer ranks (`*.bin`) are `ArrayBuffer`s: a Worker bundles them as Workers `Data`
// modules, Models' workerd tests load them with the same module rule and its Node.js tests through tools/vitest's
// `binModules` (vitest.config.ts). Declared here because Models' program compiles translation's sources.
declare module "*.bin" {
  const data: ArrayBuffer;
  export default data;
}
