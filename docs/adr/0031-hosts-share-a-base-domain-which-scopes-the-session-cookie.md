---
status: accepted
---

# Hosts share a base domain, which scopes the session cookie

A deployment has a **base domain** (`COMMISSARY_DOMAIN`), and every hostname it serves is under it: the app host (`COMMISSARY_APP_DOMAIN`, the base domain itself or a host under it, by default the base domain) and Commissary Cloud's auth host (`auth.<base domain>` by default, never the app host or the API host). Commissary Cloud's session cookie is scoped to the base domain. Commissary Cloud then runs as `commissary.dev` (a landing page, later), `app.commissary.dev`, `auth.commissary.dev` and `api.commissary.dev`. ADR 0030 had the auth host under the app host and the cookie scoped to the app host, which left no place for a landing page beside the app: this replaces that part of it.

`COMMISSARY_DOMAIN` keeps its name and becomes the base domain, and the app host defaults to it, so a deployment that sets only `COMMISSARY_DOMAIN` (every self-hosted one) keeps serving everything there, with the auth host where it was.

The tradeoff: the browser sends the session cookie to every host under the base domain, a landing page and the API host included. Only the auth Worker reads it (the app Worker passes it on), so another host under the base domain must not log or forward cookies, and nothing untrusted may be served under the base domain.

## Considered Options

- The cookie scoped to the app host and the auth host under the app host (ADR 0030): a landing page would sit outside the deployment's hosts, or the app would take the bare domain.

## Consequences

- While the base domain is the app host the cookie keeps Better Auth's name. Once the base domain is above the app host it is named `__Secure-commissary.*`: a browser keeps a cookie of the old scope apart under the same name, sends the older one first, and Better Auth reads the first, so the old cookie would shadow the new one and sign-out could not clear it. Renamed, it is ignored: everyone signs in once more after the switch.
- Moving the auth host re-registers the OAuth callbacks; moving the app host moves the Turnstile hostname, the Access application and the zone routes.
