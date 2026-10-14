---
status: accepted
---

# The API and the panel may have separate hostnames

A deployment may give its proxy routes a hostname of their own, the API host (`CF_LLM_PROXY_API_DOMAIN`, for example `api.example.com`). The control panel, sign-in and the management API stay on the app host (`CF_LLM_PROXY_DOMAIN`, for example `app.example.com`). With an API host, each hostname serves only its own paths, and a path on the wrong one answers `404` naming the right host. The management API stays on the app host: the panel calls it from there, and scripts with management keys can call it there too, so only one host needs the browser protections. Without the setting, one hostname serves everything as before. Pull-request previews always serve everything from their single `workers.dev` URL.

The split gives clients a stable address that is only an API, and it frees the bare domain and `www` for a landing page and `docs.` for documentation. One Worker answers on both hostnames and decides by hostname before routing, so storage, bindings and deploys stay shared. On a self-hosted proxy, Access covers the app host only and the API host has no Access application. This replaces the list of path exceptions the single host needs, which had to change whenever a proxy route was added.

## Consequences

- Moving to an API host changes every client's base URL, and on a hosted proxy people sign in again because the session cookie belongs to the old hostname.
- OAuth callbacks and the Turnstile widget of a hosted proxy name the app host.
- Clients that sign in through Access send the app application's token to the API host; the Worker verifies it against the application's AUD itself.
