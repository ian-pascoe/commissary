---
status: accepted
---

# Spend limits count API-equivalent cost and are checked before each attempt

Orgs limit usage in dollars. The cost of an attempt is its token breakdown priced at the model's per-token prices: those from the model catalog, unless the org has a price override (a negotiated rate, or a model the catalog does not price). Subscription accounts cost nothing per request, but their attempts are counted at the same API-equivalent price as an API key's. One dollar figure then measures every member alike, whichever credential served them, and an org can see what its subscriptions are worth.

A spend limit caps cost over a calendar day, week or month in the org's time zone. It can be set on a member, a team, the whole org, a shared credential or a proxy key. An attempt goes ahead only if every limit that applies to it has room left. The org's ControlPlane checks the limits before it picks a credential and charges the actual cost when the attempt reports back.

## Considered Options

- Reserving an estimated cost before each attempt and settling it afterwards. This would keep spend under the limit, but the estimate needs the output length, which is unknown until the answer ends. It may be added later for orgs that need hard ceilings.
- Counting only API-key spend. Subscription traffic would then be free and unlimited, and most traffic goes through subscriptions.

## Consequences

- Attempts already running when a limit is reached still finish, so spend can pass a limit by the cost of the attempts in flight.
- Each usage record stores its cost, computed with the prices at the time of the attempt, so a later price change does not rewrite past spend.
- An attempt on a model without a price costs nothing and its record is marked unpriced. The control panel shows unpriced traffic so an org admin can add a price override.
- Traffic on private credentials does not count against member, team or org limits, because it is not the org's spend and org admins may not see it. A limit on a proxy key counts everything that key spends.
- A refusal belongs to the request, not to a credential: no cooldown is set and no other credential is tried. A shared credential's own limit is the exception, skipped like an unavailable credential.
- A limit counts from the moment it is created, and a change of the org's time zone or first day of the week starts the periods that begin differently afresh. An org starts with no limits, so nothing changes for an org until an org admin sets one.
