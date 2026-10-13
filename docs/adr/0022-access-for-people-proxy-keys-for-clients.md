---
status: accepted
---

# Access authenticates people; the proxy authorizes them and issues proxy keys to clients

This replaces ADRs 0005 and 0006. Cloudflare Access still signs people in, for the control panel and the management API, but it only answers who someone is. Which orgs they belong to and which role they hold there is the proxy's own data, so a hosted org needs no Access configuration of its own. Clients no longer authenticate through Access: they send a proxy key, which the proxy issues to a member, stores only as a hash, and which names its org in a visible prefix. Access service tokens remain for automation of the management API.

Access cannot carry clients for many orgs. An account holds at most 50 service tokens (more only on Enterprise), they are created by deploying rather than by the org, and Access policies have no notion of an org. A hosted Access application admits anyone who can sign in with one of its login methods, such as a one-time PIN, Google or GitHub, and the proxy decides what they may see. An org that wants its own single sign-on gets an identity provider added to the Access account; an account holds at most 50, so this is a feature for a limited number of orgs.

## Roles

- **Platform admins** are named by the deployment's variables and need no stored state, so they can always repair the Platform registry or any org. They replace the deployment admins of ADR 0006.
- **Org roles** are owner, admin and member, held in the org.
- ADR 0006's rule carries over to each org: only a service token that holds the owner role in its org, or a platform admin, may download a stored credential or grant a service token admin rights. A person's browser session cannot grant itself those powers.

## Consequences

- The proxy routes (`/v1*`, `/openai/v1*`, `/backend-api/codex*` and their aliases) are no longer behind Access. The Worker's proxy key check is their only gate, so ADR 0005's guarantee that nothing reaches the Worker without passing Access now covers only the control panel and the management API.
- Clients that send Access service token headers to the proxy routes must switch to proxy keys. Self-hosted deployments issue them from the control panel.
- Browsers do not attach proxy keys on their own, so cross-site request forgery stops being a risk for the proxy routes. The defences stay for the Access-gated routes.
- The Go server's client keys are still accepted on import and never enforced; proxy keys are a new kind of key, not a revival of them.
