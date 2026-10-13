---
status: accepted
---

# Credentials are used through grants, which only allow and match the upstream model

Every credential has an owner: the org (a shared credential) or one member (a private credential). A member may use a shared credential only through a grant. A grant names a subject (a member, a team or everyone in the org), the shared credentials it covers (one credential, those of one provider, or all of them) and the model patterns allowed on them. For example, "member A may use Sonnet on subscription A" is one grant. A member's access is the union of their grants. A new org starts with the grant "everyone may use every shared credential for every model", which an org admin deletes to restrict access.

Grants have no deny rules. With allow and deny mixed, the answer to "what can this member use?" depends on ordering and precedence that admins get wrong. With grants that only allow, it is the list of the member's grants.

Patterns match the upstream model, not the model id the client asked for. Otherwise a model alias would reach a model the member was never granted.

## Private credentials

A private credential is used only by its owner, and grants do not apply to it: no grant can extend it to anyone else, and org admins cannot restrict which models its owner uses on it. To share one, a member makes it shared, which hands it to the org. Org admins see that a private credential exists, with its provider and owner, but not its usage, models or allowances. An org can forbid members from connecting private credentials.

## Consequences

- Selection drops every credential and upstream model the member has no grant for before priority tiers and session affinity apply. Session affinity checks grants again, because a member may lose access to a credential a session is bound to.
- Model lists are computed per member: a model id appears only if the member can reach one of its upstream models. For an alias pool, only the granted upstream models are tried.
- Model prefixes (`work/gpt-5`) still pin one credential, and only work when the member has a grant for it.
