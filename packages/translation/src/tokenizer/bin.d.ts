// `*.bin` imports are `ArrayBuffer`s: the package's tests load them through tools/vitest's `binModules`; a Worker that
// bundles the tokenizer loads them as Workers `Data` modules and declares them itself (apps/app/src/env.d.ts).
declare module "*.bin" {
  const data: ArrayBuffer;
  export default data;
}
