# Alchemy instead of Wrangler for infrastructure

All infrastructure is declared with Alchemy v2: the Worker, durable objects, KV, D1, assets, cron, and the Cloudflare Access application with its policies and service tokens. There is no Wrangler configuration. The project started on Wrangler and moved because Alchemy provisions Access in the same deployment as the Worker, and each pull request preview gets its own. The cost is a young, pinned toolchain. Adding a Wrangler file would create a second source of truth.
