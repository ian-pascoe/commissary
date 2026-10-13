---
status: accepted
---

# The proxy keeps as little as it can, and deletes at once

Every proxy, self-hosted or hosted, leans toward zero data retention. Deleting an org, a member, a credential, a proxy key or a person's sign-in account removes it at once: there is no grace period, no soft delete and no restore, so the panel offers an export before an org is deleted and asks for its name to confirm. The proxy stores no prompt or response content beyond what serving requests needs: the replay state that thinking and continuity depend on stays, bounded by its expiry of at most seven days, while usage records keep an upstream failure's status, type and code but not its body. Usage records are pruned after an org's retention period.

A hosted proxy holds other people's provider tokens and traffic metadata, and an org that leaves expects them gone. A grace period would protect against mistakes, but it would also keep data nobody asked us to keep; the export covers the mistake instead.

## Consequences

- Removing a member also removes their proxy keys and private credentials in that org; deleting a person's sign-in account does so in every org. It is refused while they are the only owner of an org that has other members.
- New orgs keep usage records for 90 days by default. Orgs that existed before this decision keep them until an org admin sets a period, so upgrading deletes no history.
- Suspending an org or person deletes nothing; it is the reversible step for a platform admin.
