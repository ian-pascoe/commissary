// Vite `?raw` imports: the D1 migrations the tests apply to the `SignIn` database (support.ts).
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
