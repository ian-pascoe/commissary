---
status: accepted
---

# A hosted proxy signs people in itself, with Better Auth

This amends ADR 0022 for hosted proxies. A self-hosted proxy keeps Cloudflare Access in front of the control panel and the management API. A hosted proxy, chosen by the deployment, has no Access application: the Worker signs people in itself with Better Auth (GitHub and Google to start, single sign-on per org later through its SSO plugin), and anyone may sign up. Either way the result is a verified email, so membership, roles, grants and limits work the same on both.

Every person who signs in through Access takes a Zero Trust seat until an admin removes them, and sign-ins are refused once the seats run out. Access cannot tell members from strangers, because membership lives in the proxy, so an open hosted application would let anyone use up the seats; per-seat pricing would also make every member a cost.

## Considered Options

- Access for everyone, paying per seat and removing inactive people automatically. Simplest, but strangers take seats and the free plan caps the service.
- Access with the Worker copying member emails into an Access policy. Keeps strangers out, but the Worker would hold an API token that can change Access.
- WorkOS AuthKit. The least security code of our own, but a vendor dependency, a monthly fee per org with single sign-on, and people's emails held by a third party.
- Our own sign-in on top of an OAuth library. Full control, but sessions and single sign-on would be ours to write and keep secure.

## Consequences

- Better Auth stores people and sessions in D1. Only its core and SSO plugin are used: its organization plugin would duplicate the org's members and teams, which stay in the org's ControlPlane.
- Hosted proxies have no Access service tokens. Scripts use management keys instead, which never grant the sensitive powers, so on a hosted proxy only platform admins can download a stored credential (ADR 0006's rule, per ADR 0022).
- Platform admins of a hosted proxy are the people in the deployment's list who signed in with that email verified by GitHub or Google.
- Keeping Better Auth patched is our job, and the Worker's sign-in, session and CSRF handling become security-critical code.
