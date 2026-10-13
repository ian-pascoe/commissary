---
status: accepted
---

# The proxy serves many orgs, each with its own ControlPlane

This replaces ADR 0007. The proxy stops being one person's gateway: one deployment serves one or more orgs, so that an org can host the proxy for itself and we can run it as a hosted service with the same code. A self-hosted deployment is simply a deployment with one org. Each org has its own ControlPlane, the only writer of that org's state: its config entries (ADR 0025), credentials and cooldowns, login sessions, allowances and reset grants, members, teams, grants, proxy keys and spend counters. The single-writer design and its trade-off from ADR 0007 still hold, but per org: one org's traffic never waits on another's.

A Platform registry, one object per deployment, holds what spans orgs: the list of orgs, which orgs each person belongs to, and which org each Access service token belongs to. The platform admins are not in it: the deployment's settings (`PLATFORM_ADMIN_*`) name them, so they can always repair it. It stays out of the request path for clients, because a proxy key names its own org.

## Considered Options

- One deployment per org. This gives the strongest isolation, but a hosted service would run and upgrade one deployment per customer, and self-hosting would differ from hosting.
- One global ControlPlane holding every org. This keeps ADR 0007 as it is, but every org's traffic would pass through one object and one org's load would slow the others.

## Consequences

- The existing deployment becomes an org with the id `global`, the name its ControlPlane already has, so upgrading moves no data.
- Each org has its own auth index key, derived from the deployment's key and the org id, so the same credential gets unrelated handles in two orgs.
- Usage records, session state addresses and caller scopes include the org. The model catalog is still shared by every org.
- Scheduled work (token refresh sweeps, catalog refresh, status checks) runs once per org instead of once per deployment.
- A provider login's OAuth `state` names its org, so the public callback paths reach the right ControlPlane.
