// Vite `?raw` imports: the D1 migrations `@commissary/models/testing` applies to the usage database (resetUsageDb).
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
