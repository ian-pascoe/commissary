# Pricing and billing: comparables, Cloudflare unit costs, billing stack

Ticket: #116 (map #101). Researched 2026-10-15 against vendor pricing pages, docs and changelogs. Prices are USD, list price, as shown on the fetched date. Pricing pages change often; re-check before deciding.

## Answer

**1. How comparable services price and tier.** Three patterns recur.

- **Gateways charge for the platform or logs, not for tokens.** OpenRouter passes model prices through and takes a fee on credit purchase (5.5%, $0.80 minimum on Standard; 8% on Business). Cloudflare AI Gateway core features are free and it charges 5% on Unified Billing credits. Helicone and Portkey charge a flat monthly fee plus usage measured in requests or logs ($79 and $49 per month entry paid tiers). Free tiers are usually capped on requests, logs or retention (Helicone 10k requests, Portkey 10k logs).
- **Tool platforms charge per call or per user.** Composio: 100k tool calls and 3 members free; Pro $29 per month with a $29 usage credit. Arcade: 2,000 tool calls free; $0.01 per call and $25 per month. Pipedream: free for development, then $99 per month with 100 external users, $2 per extra user and $0.012 per credit (one credit per 30 s of compute). Smithery's pricing page rendered no prices and it now belongs to Arcade.
- **Browsers charge per browser hour, with concurrency as the tier gate.** Browserbase: $0.12 or $0.10 per hour on paid tiers, $20, $99 or custom per month. Steel: $0.10 per hour on Launch and $0.08 on Scale ($250 per month). Hosted agents charge seats plus a usage pool (Devin Teams: $40 per full seat, $80 per month minimum, plus on-demand credits shared by the team; Enterprise is billed in ACUs).

Seats appear mainly where the product is a human-facing app (Devin, Cursor, Helicone's unlimited seats on Pro). Programmatic platforms (Composio, Arcade, Pipedream) charge for calls or end-users and give "team members" away.

**2. Commissary's unit costs on Cloudflare.** All are usage-based with a $5 per month Workers Paid base per account. A proxied LLM request costs roughly $0.30 per million Worker requests plus $0.02 per million CPU-ms (so roughly $0.50 per million requests at about 10 ms CPU), with no duration charge and no egress charge. Durable Objects add $0.15 per million requests and $12.50 per million GB-s. D1 or DO SQLite writes cost $1.00 per million rows. Browser Run is $0.09 per hour after 10 free hours, plus $2 per extra concurrent browser. Containers are billed per 10 ms of active use (details below). Cloudflare's own pricing is far below the comparables' per-unit prices, so there is room for margin in every area except possibly Containers-backed Agents, which depend on instance size and uptime.

**3. Billing on Workers.** Stripe's SDK runs on Workers using the Fetch HTTP client, and webhook signature verification has an async variant (`constructEventAsync`). A merchant of record (MoR) is a separate, larger decision because it changes who owes tax and what the fees are (see the table). Stripe's own MoR, Managed Payments, now exists (3.5% on top of Payments fees, digital products only, requires an eligible business location); Lemon Squeezy is Stripe-owned and is moving to it; Paddle and Polar charge 5% + $0.50 on their base plans. Usage billing is the hard part with MoRs: Stripe's Billing Meters are the established path with a Stripe-as-merchant integration, but this research did not confirm that Managed Payments supports metered or Metronome prices. Paddle's native usage billing is in early access (beta). Polar has native meters and credits.

## 1. Comparable services

### 1.1 LLM gateways

| Service | Entry / free | Paid | Charged for | Source |
| --- | --- | --- | --- | --- |
| OpenRouter | Free plan: 25+ free models, 50 requests per day, no budgets | Standard pay-as-you-go: 5.5% platform fee ($0.80 minimum per purchase). Business: 8%. Enterprise: custom. BYOK: free up to $25,000 of list-price inference per month, then 5% | Fee on credit purchases; inference at provider list price, no markup. Budgets and spend controls, management API keys and admin controls are paid plans only; SSO/SAML only Enterprise | https://openrouter.ai/pricing , https://openrouter.ai/docs/faq |
| Portkey | Developer: free, 10k recorded logs per month, 3 days log retention | Production: $49 per month, 100k logs, +$9 per extra 100k; Enterprise custom (RBAC, SSO, granular budget and rate limits are Enterprise) | Recorded logs (excess logs are not recorded, requests keep working); governance features gated to Enterprise | https://portkey.ai/pricing (page dated 2026-09-15) |
| Helicone | Hobby: free, 10,000 requests, 1 GB, 1 seat, 7 days retention | Pro $79 per month (unlimited seats, 1 organization); Team $799 (5 organizations); Enterprise custom; usage-based pricing above the included amounts | Requests, storage, plan tier. Its AI Gateway credits are 0% markup | https://www.helicone.ai/pricing , https://docs.helicone.ai/getting-started/platform-overview . Page says "Helicone joins Mintlify", so plans may change |
| LiteLLM | Open source (MIT outside `enterprise/`) | Enterprise: custom, sales-led (virtual keys, budgets, RPM/TPM limits, spend by key/user/team/org; SSO/SCIM, audit logs, RBAC are listed as Enterprise features) | Self-hosted licence; price not published on the page I fetched. I did not find a public "LiteLLM Cloud" price list | https://www.litellm.ai/enterprise , https://github.com/BerriAI/litellm/blob/main/LICENSE |
| Cloudflare AI Gateway | Core features (analytics, caching, rate limiting) free on all plans | Unified Billing credits carry a 5% fee. Guardrails billed as Workers AI inference. Logs: Workers Logs pricing for gateways created from 2026-09-24; legacy log caps (100k logs total on Free, 10M per gateway on Paid) for older gateways | Credits fee, logs, Guardrails | https://developers.cloudflare.com/ai-gateway/reference/pricing/ (updated 2026-09-24) |

Note for Commissary's glossary terms: comparables gate **spend limits / budgets** and **SSO** to paid tiers (OpenRouter, Portkey, LiteLLM, Helicone Enterprise), and give **proxy-key-like** API keys and logs on free tiers. OpenRouter's BYOK fee corresponds to Commissary's credential **private** (member-supplied credentials) case; a fee-free BYOK allowance is a published precedent.

### 1.2 MCP and tool platforms

| Service | Free | Paid | Unit | Source |
| --- | --- | --- | --- | --- |
| Composio | Hobby: 100,000 tool calls, 50,000 triggers, 3 team members per month, unlimited connected accounts | Pro $29 per month including $29 usage credit (expires monthly), unlimited members, spend controls; Enterprise custom | Tool calls, triggers; Composio-managed OAuth apps have lower allowances and count toward the free tier | https://composio.dev/pricing |
| Pipedream (Connect) | Free: development only, unlimited team members | Startup $99 or $150 per month (the page shows both figures with a monthly/annual toggle; I could not tell which is which) with 100 external users included then $2 per user; 10,000 credits then $0.012 each; Business custom | External users, plus credits (1 credit per 30 s compute for each action, MCP tool call, proxy request or trigger event). Production use requires Startup | https://pipedream.com/pricing (the monthly/annual price rendering on the page is garbled; confirm before relying on it) |
| Arcade (owner of Smithery) | Free: 2,000 auth events and 2,000 tool calls per month | Team $25 per month + $0.10 per auth event + $0.01 per tool call; Enterprise custom | Auth events, tool calls | https://www.arcade.dev/pricing |
| Smithery | Page says Smithery is now part of Arcade.dev; no prices rendered | n/a | n/a | https://smithery.ai/pricing . Docs: https://smithery.ai/docs/use/connect (hosted connections, OAuth and token refresh; credentials write-only) |

### 1.3 Hosted browsers

| Service | Free | Paid | Unit / gates | Source |
| --- | --- | --- | --- | --- |
| Browserbase | 1 browser hour, 3 concurrent, 15 min sessions | Developer $20: 100 hours then $0.12 per hour, 25 concurrent, 1 GB proxy then $12 per GB. Startup $99: 500 hours then $0.10, 100 concurrent. Scale: custom | Browser hours, concurrency, proxy GB, search and fetch calls, agent runs | https://www.browserbase.com/pricing |
| Steel | Launch: $0 + usage, $30 one-time credit, 10 concurrent, 15 min sessions | Scale $250 per month + usage with $100 monthly credit, 100 concurrent, 1 hour sessions. Rates: browser hours $0.10 (Launch) or $0.08 (Scale); proxy $10 or $6 per GB; CAPTCHA $3 or $1 per 1k | Browser hours, proxy bandwidth, CAPTCHA solves; concurrency and max session time gate tiers | https://steel.dev/pricing |

### 1.4 Hosted agents

- **Devin (Cognition).** Self-serve Free (limited), Pro $20 per month (1 member), Max $200 per month (1 member), Teams $80 per month minimum (up to 200 members; full seat $40 per month, flex seats exist; on-demand credits shared by the team). Enterprise is billed in Agent Compute Units (ACUs) at order-form rates. Plans combine daily and weekly quota with pay-as-you-go on-demand credits. Source: https://docs.devin.ai/admin/billing , https://docs.devin.ai/admin/billing/self-serve . The `devin.ai/pricing` page 404'd for me; the docs defer to it as authoritative.
- **Cursor.** The pricing pages I fetched (https://cursor.com/pricing , https://cursor.com/docs/account/pricing) now describe Cursor as sold within "The X Subscription" with Free, Plus $8, Premium $30, Super $100 and Ultra $200 per month, weekly usage pools, third-party models at API list price from prepaid credit on Premium and above, Cloud Agents on Premium and above, and Teams at $30, $100 or $200 per seat. Legacy Pro/Pro+/Ultra/Teams plans still work. This differs a lot from earlier Cursor pricing and the page is odd (mixes in X features); treat it as current but verify before citing. Enterprise adds the Cursor Token Rate on top of API list price (a markup on model cost, rate not read).
- **Cloudflare Agents.** No separate price: Agents run as Durable Objects on Workers, billed at Workers and Durable Objects rates (limits page: https://developers.cloudflare.com/agents/platform/limits/ ; I did not find an Agents pricing page: `/agents/platform/pricing/` returned 404).

Units across hosted agents: seats plus a shared usage pool (Devin Teams, Cursor Teams), prepaid or on-demand credits for overage, and compute-based units for enterprise (Devin ACU).

## 2. Commissary's own costs on Cloudflare

All from the Cloudflare developer docs. Workers Paid is $5 per month minimum per account and includes the allotments below. "Included" amounts are per account, not per customer, so a multi-tenant gateway shares one allotment.

| Area | Item | Rate (Workers Paid) | Source |
| --- | --- | --- | --- |
| Models, all | Worker requests | 10M included, then $0.30 per million. Subrequests (calls to upstream LLMs) are not billed; WebSocket messages through a Worker are not requests; no duration charge; no egress or bandwidth charges | https://developers.cloudflare.com/workers/platform/pricing/ (updated 2026-10-02) |
| | Worker CPU time | 30M CPU-ms included, then $0.02 per million CPU-ms; default 30 s CPU limit, up to 5 min | same |
| | Workers Logs | 20M events included then $0.60 per million; 7 days retention. From 2026-12-01 Cloudflare Observability pricing replaces this table | https://developers.cloudflare.com/workers/observability/logs/workers-logs/ |
| Durable Objects (state, rate limiting, agents) | Requests | 1M included then $0.15 per million (HTTP, RPC sessions, alarms; incoming WebSocket messages billed at 20:1) | https://developers.cloudflare.com/durable-objects/platform/pricing/ (updated 2026-09-30) |
| | Duration | 400,000 GB-s included then $12.50 per million GB-s while active or unable to hibernate; hibernating idle objects are not billed duration | same |
| | SQLite storage | 5 GB-month included then $0.20 per GB-month; rows read 25B included then $0.001 per million; rows written 50M included then $1.00 per million; storage billing was scheduled to start January 2026 | same |
| D1 | Rows read / written / storage | 25B reads then $0.001 per million; 50M writes then $1.00 per million; 5 GB then $0.75 per GB-month; no egress | https://developers.cloudflare.com/d1/platform/pricing/ (updated 2026-04-21) |
| Browser (hosted) | Browser Run | 10 hours per month then $0.09 per hour; concurrent browsers (Sessions only): 10 included, averaged monthly of daily peaks, then $2.00 per browser; failed Quick Action timeouts are not billed; usage visible via `X-Browser-Ms-Used` header | https://developers.cloudflare.com/browser-run/pricing/ (updated 2026-04-21). The product is now called Browser Run; older docs say Browser Rendering |
| Agents (hosted, if sandboxed) | Containers | Billed per 10 ms while running: memory $0.0000025 per GiB-s (25 GiB-hours included), CPU $0.000020 per vCPU-s (375 vCPU-min included), disk $0.00000007 per GB-s (200 GB-hours included); memory and disk follow provisioned instance size, CPU follows active use. Instances from lite (1/16 vCPU, 256 MiB) to standard-4 (4 vCPU, 12 GiB). Egress: $0.025 per GB NA/EU (1 TB included), $0.05 Oceania/Korea/Taiwan, $0.04 elsewhere (500 GB included). Each container also incurs Worker and DO charges | https://developers.cloudflare.com/containers/platform/pricing/ (updated 2026-10-05). Sandbox SDK pricing equals Containers: https://developers.cloudflare.com/sandbox/sdk/platform/pricing/ |

Worked estimate (my arithmetic, not a vendor figure): a proxied request with 10 ms CPU costs $0.30/1M + 10 × $0.02/1M = about $0.50 per million requests; adding one DO RPC for each request (e.g. rate-limit or spend counter) adds $0.15 per million; one D1 or DO-SQLite row written per request for usage logging adds $1.00 per million. So per-request logging writes cost more than the proxy compute itself, which matters for the metering design (batch usage rows). Browser at $0.09 per hour is below Browserbase ($0.10 to $0.12) and Steel ($0.08 to $0.10) per-hour prices; concurrency at $2 per browser is a separate cost.

Not researched: pi-durable's own container needs (that is for the Agents ticket), Workers AI, R2, Queues, and Workers for Platforms.

## 3. Billing on Workers

### 3.1 Stripe

- **Stripe on Workers.** Stripe's Node SDK works in Workers when constructed with the Fetch HTTP client (`Stripe.createFetchHttpClient()`), announced by Cloudflare in 2021 (https://blog.cloudflare.com/announcing-stripe-support-in-workers/). Webhook signature checking uses `constructEventAsync` (WebCrypto) rather than the sync version (https://github.com/stripe/stripe-node, `src/Webhooks.ts`). Cloudflare/Stripe template: https://github.com/stripe-samples/stripe-node-cloudflare-worker-template (2021; check currency, secondary source for the pattern).
- **Webhook handling.** Stripe retries undelivered events for up to three days and lists events from the last 30 days; it advises returning 2xx quickly and processing asynchronously through a queue (https://docs.stripe.com/events/manage-webhook-endpoints , https://docs.stripe.com/webhooks/signature). On Workers this suggests verify, enqueue (Queues or a DO), return 200.
- **Billing Meters.** Usage is sent as meter events (`/v1/billing/meter_events`) with a customer id, numeric value, optional idempotency identifier; timestamps must be within the past 35 days and at most 5 minutes in the future; rate limit 1,000 calls per second per account and one concurrent call per customer per meter; per-meter dimension cardinality limits (10,000 combinations per hour, 100 per customer). Processing is asynchronous so invoices may lag recent events. Stripe now calls Metronome (acquired) its primary usage-based platform for all new integrations and Billing Meters a lower-level primitive that remains supported, with up to 100M events per month included in Billing pricing. Sources: https://docs.stripe.com/billing/subscriptions/usage-based , https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage-api , https://stripe.com/billing/pricing .
- **Billing credits and customer portal.** Stripe offers billing credits for prepaid or promotional usage-based products (https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits). The customer portal is included in Billing; a custom domain costs $10 per month (https://stripe.com/billing/pricing).
- **Fees.** Payments 2.9% + 30¢ domestic cards. Billing: 0.7% of Billing volume pay-as-you-go (annual-commit tiers from $620 per month). Tax: 0.5% per transaction (no-code integration) or 50¢ per transaction (API) where you are registered to collect; tax filing and registration extra via partners. Sources: https://stripe.com/pricing , https://stripe.com/billing/pricing , https://stripe.com/tax/pricing .
- **Tax responsibility with plain Stripe.** You are the seller. Stripe Tax calculates and collects but you must register and file (Stripe offers partner registration and filing as extras). Tax calculation alone does not remit.

### 3.2 Merchants of record

| | Stripe Managed Payments | Paddle | Lemon Squeezy | Polar |
| --- | --- | --- | --- | --- |
| Base fee | 3.5% per transaction on top of Payments fees (2.9% + 30¢ cards), so roughly 6.4% + 30¢ before extras | 5% + 50¢ per Checkout transaction, all-inclusive, no monthly fee; custom for high volume or low value (under $10 contact them) | 5% + 50¢ per transaction, no monthly charge | Starter 5% + 50¢. Pro $20 per month 3.8% + 40¢; Growth $100 3.6% + 35¢; Scale $400 3.4% + 30¢. +1.5% international cards. Organizations created before 2026-05-27 keep an Early Member rate (4% + 40¢, +0.5% subscriptions) while on it |
| Tax | MoR for sales tax, VAT, GST in 80+ countries. Where it does not cover, you remain responsible and use Stripe Tax at no extra calc fee | MoR; collects, files, remits | MoR | MoR (Polar says it is built on Stripe) |
| Usage-based billing | Not confirmed (see caveat below) | Native usage-based billing is early access (beta) behind an application form; otherwise subscriptions plus one-time charges or modifiers | Docs/blog mention consumption billing (2023 post); not verified | Native events, meters, metered prices and a Meter Credits benefit |
| Constraints | Digital products only (SaaS, IaaS, PaaS tax codes included); no Connect, no marketplace; business must be in a listed country (US, CA, most of Europe, AU, HK, JP, SG); sold via Checkout or Payment Links; many Checkout parameters removed (`automatic_tax`, `payment_method_types`, etc.); customer sees "Sold through Link" | Seller approval and prohibited-product review (not read in detail) | Owned by Stripe since 2024; 2026-01-28 post says it is building on Managed Payments | Open source MoR; webhooks follow Standard Webhooks headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`); SDK has `validateEvent` |
| Sources | https://docs.stripe.com/payments/managed-payments , .../eligibility , .../how-it-works , .../update-checkout , https://stripe.com/pricing | https://www.paddle.com/pricing , https://developer.paddle.com/build/usage-based-billing , https://developer.paddle.com/get-started/how-paddle-works/ai-companies/ | https://www.lemonsqueezy.com/pricing , https://www.lemonsqueezy.com/blog/stripe-acquires-lemon-squeezy , https://www.lemonsqueezy.com/blog/2026-update | https://polar.sh/docs/merchant-of-record/fees , https://polar.sh/docs/features/usage-based-billing/introduction , https://polar.sh/docs/integrate/webhooks/delivery |

Trade-offs, stated neutrally:

- **Stripe direct + Stripe Tax:** lowest percentage cost and the most flexible metering (Billing Meters, credits, portal), but Commissary is the seller, owns registration, filing, VAT/sales-tax thresholds and disputes. Selling software to consumers and businesses worldwide creates registration obligations in multiple jurisdictions as thresholds are hit.
- **MoR:** one fee covers tax, disputes and support and removes tax filing, at roughly 5% + 50¢ (Paddle, Polar, Lemon Squeezy) or about 6.4% + 30¢ (Stripe Managed Payments) per transaction, and it limits pricing-model flexibility (Polar's own docs list "less flexibility and control in terms of advanced business and pricing models" and higher fees as MoR costs). Fixed 50¢ components hurt small payments; credit top-ups or small tiers pay proportionally more, which matters for a free-tier-to-paid funnel with small prepaid credits.
- **Prepaid credits vs invoiced overage:** the gateways above mostly use prepaid credits (OpenRouter, Helicone) or monthly plan plus overage (Portkey, Pipedream, Composio). Credits bill the fee at purchase (a single fee on a larger sum), which interacts with the per-transaction fixed fee.

### 3.3 Sales tax and VAT

- Digital services sold to EU consumers owe VAT in the customer's country; a MoR (Paddle, Polar, Lemon Squeezy, Stripe Managed Payments) takes the liability. I did not fetch EU/US tax authority primary sources in this pass; the MoR docs above are the sources for what each vendor covers. Details on thresholds (EU OSS, US state economic nexus) should be checked with a tax adviser or the Stripe Tax threshold monitoring, which sends alerts at thresholds.
- Managed Payments covers 80+ countries and excludes some; in uncovered countries the seller is responsible, with Stripe Tax as the compatible tool (https://docs.stripe.com/payments/managed-payments/tax-compliance). The docs say Stripe Tax is the only tax tool compatible with Managed Payments.
- Self-hosted Commissary installs are out of scope for billing: the paid service applies to Commissary Cloud only.

## 4. Open questions and caveats for the decision ticket

- Managed Payments with usage-based billing: the docs I read list removed Checkout parameters and note subscription support "with Billing"; I did not find a statement that metered prices or Metronome work with Managed Payments. Ask Stripe or test in a sandbox before assuming a Stripe MoR + usage model.
- Paddle usage-based billing is early access; Polar's meters are the only MoR-native usage billing I verified in docs.
- A pure subscription (flat tiers plus included usage, no metering) works on every option; metering is only needed for overage or prepaid-credit burndown.
- Pipedream's $99 vs $150 monthly/annual display was garbled on its page; Cursor's pricing page is entangled with X/Grok plans; Smithery's page rendered no prices; Devin's pricing page returned 404. These are stated above as such.
- Cloudflare price pages are dated Apr to Oct 2026; Workers Logs pricing changes on 2026-12-01 and Cloudflare AI Gateway logs pricing changed on 2026-09-24, so Commissary's per-request observability costs are in flux.
- The 20:1 WebSocket message ratio, DO duration billing and Containers' instance sizing matter for the Agents area; modelling those needs pi-durable's real resource profile, which is outside this ticket.
- Whether Commissary Cloud proxies provider credentials it owns (resale with markup) or only BYOK changes everything on the model-cost side: OpenRouter, Helicone and Cloudflare all pass provider prices through and charge fees on credits; Cursor Enterprise adds a token-rate on top of API list price. The research did not weigh margins; that is a product decision.
