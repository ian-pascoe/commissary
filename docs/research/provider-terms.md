# Provider terms: subscription accounts in a paid hosted service

Research for ticket #104 (map #101). Researched 2026-10-15. Sources are the providers' own terms, policies, help-center and docs pages, and first-party announcements. Where only a press article or forum post exists, that is said.

Definitions used here (from the project glossary):

- **Private credential**: a member's own subscription, used only for that member's requests, through Commissary Cloud (a hosted third party that would store or relay the login).
- **Shared credential**: one subscription whose use is spread across several members of an org (a seat or login that more than one person's requests go through).

## Answer

**No provider's terms clearly permit a shared credential, and almost none permit a private one in a *hosted* third-party gateway, except where the provider has built an explicit program for it.** Summary (details and citations below):

| Provider | Private credential (member's own plan, own requests, via hosted service) | Shared credential (one plan across an org) |
|---|---|---|
| **Anthropic** (Pro/Max/Team/Enterprise, Claude Code) | **Not permitted as written.** Anthropic "does not permit third-party developers ... to route requests through Free, Pro, or Max plan credentials on behalf of their users", and developers "may not collect, store, or intermediate Claude.ai credentials or session tokens". Narrow exception: a user signing in to the *unmodified* Claude Code binary with their own plan, even when a platform hosts that binary. Support pages (Oct 2026) say third-party apps still draw on subscription limits, which conflicts with the legal page; unresolved. | **Prohibited.** Consumer Terms: may not share account login or make the account available to anyone else; may not resell. |
| **OpenAI** (ChatGPT, Codex) | **Permitted only through OpenAI's own "Sign in with ChatGPT" / "use your ChatGPT plan in other apps" program** (Go/Plus/Pro, participating apps, per-app weekly cap set by the user). Outside it: not permitted; tokens-in-a-hosted-service for Codex is described as an advanced, "trusted private automation" workaround, with API keys the "right way". | **Prohibited.** Terms: may not share credentials or make the account available to anyone else. Business terms: no sharing login credentials between users, no resale or lease. |
| **xAI** (SuperGrok / X Premium) | **Unclear.** xAI publicly endorses SuperGrok OAuth inside OpenCode (a local open-source client, May 2026). No text found on hosted third-party services; the AUP forbids unauthorised bot access and resale. | **Prohibited** by the account-sharing clause. |
| **Google** (Gemini CLI, Antigravity, Google AI Pro/Ultra) | **Prohibited.** Third-party software using Gemini CLI or Antigravity OAuth is stated to be a violation; accounts have been banned. Supported route is a Vertex AI or AI Studio API key. | **Prohibited** (same; plus Antigravity says automating account rotation is unsupported on consumer plans). |
| **Google Vertex AI / Gemini API** (API, not subscription) | Fine: this is the supported route (bring your own key). | Cloud Terms bar reselling/sublicensing the Services; building a *Customer Application* on them is allowed. A general Gemini API resale question had no official answer found. |
| **Moonshot** (Kimi Code, Kimi membership) | **Mostly permitted for local tools, not for relay.** Kimi Code officially supports third-party coding tools, but "interactive use only"; "Sharing your account with others through a reverse proxy is a violation"; reselling as a service and non-interactive automation are barred. A hosted relay of one person's key is closest to the forbidden category; not stated explicitly. | **Prohibited** (no account resale, no reverse-proxy sharing). |
| **Meta** (Muse Code subscription, Meta Model API) | **Restricted.** A Coding Harness Subscription credential "may not be used to access the Services outside the coding harness". API terms bar access "through any model aggregator, API gateway, proxy, or similar offering" without Meta's written authorisation. | **Prohibited** (API keys may not be shared; no resale). |
| **Devin / Cognition** | No subscription-credential relay exists; Devin is an agent product. Terms: internal business purposes, no giving anyone else account access. The supported integration is the Devin API with service users or personal access tokens. | **Prohibited** (AUP: no providing others access to account or credentials; no resale). |

What follows for Commissary Cloud (facts, not a decision):

1. The only *clearly sanctioned* subscription-in-a-third-party-service path found is OpenAI's "Sign in with ChatGPT" plan-sharing program. It is an opt-in by the user, capped per app, and limited to participating apps. Participation requirements were not published on the pages read.
2. A *shared* subscription across an org is barred in every provider's text that addresses sharing. Org-shared credentials are only safe as API keys or cloud-provider credentials (Anthropic API key, OpenAI API key, Vertex, Bedrock, Kimi Open Platform, Meta Model API with the aggregator caveat).
3. Anthropic is the strictest and most explicit on a hosted service holding subscription tokens; Google is the most actively enforcing (bans in Feb 2026).
4. Self-hosting is a different position from Commissary Cloud: the sanctioned patterns are mostly "the user runs the official client / their own copy with their own login". None of the sources address a self-hosted proxy run by the same person.

## Detail by provider

### Anthropic

- **Consumer Terms of Service**, effective Oct 8, 2025 (https://www.anthropic.com/legal/consumer-terms):
  - "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else. You also may not make your Account available to anyone else."
  - Banned uses include to "resell the Services" and, "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise."
- **Claude Code legal and compliance page** (current; no date shown) (https://code.claude.com/docs/en/legal-and-compliance), "Authentication and credential use":
  - OAuth "is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
  - Developers building products, including with the Agent SDK, "should use API key authentication". "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens".
  - "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
  - Hosting Claude Code in a product ("Can customers offer Claude Code in their products?"): needs Commercial Terms; the binary must be unmodified; "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential." The page also says the rules do not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code".
- **Commercial Terms** (Team/Enterprise/API) D.4: customer may not "resell the Services except as expressly approved by Anthropic" (https://www.anthropic.com/legal/commercial-terms). I did not find a seat-sharing clause in the text searched.
- **Enforcement and changes in 2026** (secondary: press; not Anthropic-owned pages):
  - The Register, Feb 20, 2026: Anthropic clarified the terms against third-party harnesses; the Consumer Terms automation clause had existed since at least Feb 2024 (https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546).
  - Apr 4, 2026: subscriptions stopped covering OpenClaw-type third-party tools (The Verge https://www.theverge.com/ai-artificial-intelligence/907074/anthropic-openclaw-claude-subscription-ban; TechCrunch https://techcrunch.com/2026/04/04/anthropic-says-claude-code-subscribers-will-need-to-pay-extra-for-openclaw-support/).
  - May 13, 2026: reported reinstatement through a separate monthly "Agent SDK credit" billed at API rates (VentureBeat https://venturebeat.com/technology/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch).
- **Anthropic support pages** (first-party, newest status):
  - "Use the Claude Agent SDK with your Claude plan": "Update October 7, 2026: Claude Max and Team plans now include monthly API credits ... You can still use the Claude Agent SDK, `claude -p`, and third-party apps with your subscription limits." And "Update June 15, 2026: We've paused the previously-announced changes to Claude Agent SDK usage." (https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
  - Monthly API credits for Max and Team: shared across the org linked, "Usage is never charged to your Claude plan", and these credits cannot be used in Claude Code or Claude apps (https://support.claude.com/en/articles/17154008).
- **Ambiguity**: the support page says third-party apps may draw from subscription limits, while the legal page says developers may not route through plan credentials or store tokens. I could not reconcile these. A local third-party app using the user's own login may be tolerated; a hosted service holding the OAuth token is what the legal page names as prohibited.

### OpenAI

- **Terms of Use (individuals)**, effective Jan 1, 2026 (https://openai.com/policies/terms-of-use/): "You may not share your account credentials or make your account available to anyone else"; prohibited: "Automatically or programmatically extract data or Output".
- **Services Agreement (business)**, effective Jan 1, 2026, §3.1: "Customer will not share Account access credentials or individual login credentials between multiple users. Customer may not resell or lease access to its Account or any End User Account." (https://openai.com/policies/business-terms/)
- **Codex authentication** (https://developers.openai.com/codex/auth): two sign-in modes (ChatGPT subscription, API key). ChatGPT Enterprise admins can grant "Codex access tokens" so permitted members can run "trusted, non-interactive Codex local workflows".
- **Codex in CI/CD** (https://developers.openai.com/codex/auth/ci-cd-auth/): "The right way to authenticate automation is with an API key." Using a ChatGPT-managed `auth.json` on a runner is "an advanced workflow for enterprise and other trusted private automation"; "Treat ~/.codex/auth.json like a password"; "Do not use this workflow for public or open-source repositories."
- **Plan use in third-party apps (new)**: "Using your ChatGPT plan in other apps and sites" (page shows "Updated: 7 days ago" on 2026-10-15) says Go, Plus and Pro subscribers "can also choose to use your ChatGPT plan for AI requests in participating commercial apps and sites". The user can set a weekly usage cap per app (Settings > Usage); credits are off by default; the app "may charge separately for its subscription, infrastructure, services, or premium features"; open-source tools are available to all ChatGPT users (https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites). Identity side: https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt (named initial partners: Airtable, GitLab, HubSpot, Notion, Supabase, Vercel). Not found: how an app becomes "participating", fees, or whether Commissary-type gateways qualify; there is a partner directory the page points to that I did not open.
- **Private**: permitted via that program for individual plans (Go/Plus/Pro); outside it, the programmatic-extraction and credential-sharing clauses apply. **Shared**: prohibited by both the individual and business texts.

### xAI

- **Consumer Terms of Service**, "Last Updated: October 12, 2026" (read from a Wayback copy because x.ai returned 403 to the fetcher: https://web.archive.org/web/2026/https://x.ai/legal/terms-of-service; live URL https://x.ai/legal/terms-of-service): "You may not share your account credentials or make your account available to anyone else".
- **Acceptable Use Policy**, "Effective: August 14, 2026" (Wayback copy: https://web.archive.org/web/2026/https://x.ai/legal/acceptable-use-policy): bars "reselling", "using bots to access", "Accessing the Services through unauthorized automated or non-human means, whether through a bot, script, or otherwise", "Taking unauthorized actions on behalf of others". "Unauthorized" leaves room for authorised automation.
- **First-party endorsements**: "Use Grok in OpenCode" (May 21, 2026): "Use your SuperGrok or X Premium subscription inside OpenCode" via xAI Grok OAuth, including a headless/VPS flow (https://x.ai/news/grok-opencode). "Introducing Grok Build" (May 25, 2026): coding agent for SuperGrok and X Premium Plus subscribers (https://x.ai/news/grok-build-cli). The pages say "More open-source agents and integrations are coming soon"; nothing about hosted commercial services.
- Not read: xAI enterprise/API terms and consumer FAQ (HTTP 403).
- **Private**: allowed in named local open-source clients; hosted-service use not addressed. **Shared**: prohibited by the account-sharing clause.

### Google

- **Gemini CLI** (https://geminicli.com/docs/resources/tos-privacy/, last updated Apr 10, 2026): "Directly accessing the services powering Gemini CLI ... using third-party software, tools, or services (for example, using OpenClaw with Gemini CLI OAuth) is a violation of applicable terms and policies. Such actions may be grounds for suspension or termination of your account." FAQ (https://geminicli.com/docs/resources/faq/): "the supported and secure method is to use a Vertex AI or Google AI Studio API key".
- **Antigravity Additional Terms** (https://antigravity.google/terms/): "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts." Antigravity FAQ (https://antigravity.google/docs/faq): wrapping `agy` inside third-party agents "or automating account rotation, is not supported under consumer plans"; recommends a Gemini Enterprise or AI Studio API key instead.
- **Enforcement**: Google staff post of Feb 27, 2026 in the Gemini CLI repo (https://github.com/google-gemini/gemini-cli/discussions/20632) describes bans for third-party use of Antigravity and an automated unban/remediation form; Antigravity forum post (https://discuss.ai.google.dev/t/update-on-antigravity-tos-ban/131424, Mar 12, 2026): "using third-party tools with your Antigravity login remains against our terms". A Sept 2026 press report says the terms were updated so suspension scope is narrower (TestingCatalog, secondary, not fetched).
- **Vertex AI / Gemini API (API-key route)**: Google Cloud Terms of Service §1.1 lets a customer integrate GCP services into a "Customer Application that has material value independent of the Services"; §3.3(c) bars to "sell, resell, sublicense, transfer, or distribute any or all of the Services" (https://cloud.google.com/terms). The Gemini API Additional Terms (https://ai.google.dev/gemini-api/terms, via Wayback copy) contain a resale restriction only for Grounded Results/Search Suggestions. A forum question of Sept 6, 2026 on whether holding a Gemini key and charging a markup is allowed shows no official reply in the thread as fetched (https://discuss.ai.google.dev/t/confirming-resale-reseller-policy-scope-for-the-gemini-api/181039).
- **Private and shared subscription credentials**: both prohibited; consumer Google AI Pro/Ultra via a hosted gateway has no sanctioned route.

### Moonshot (Kimi)

- **Kimi Code Community Guidelines** (https://www.kimi.com/en/help/kimi-code/community-guidelines; no date shown): "Kimi Code subscriptions are for interactive use only"; compatible with Kimi CLI, VS Code, Claude Code, OpenCode, OpenClaw; "Don't resell your account or API access"; "Don't resell Kimi Code's capabilities as a service"; "Don't use Kimi Code for non-interactive automation"; "Accessing Kimi through a forward proxy (like a VPN or company network) is fine. Sharing your account with others through a reverse proxy is a violation." Enterprise and commercial use goes to the Kimi Platform. Consequence stated: limiting concurrent access, suspension.
- **Membership docs** (https://www.kimi.com/code/docs/en/kimi-code/membership): requests from "third-party tools all count toward that quota"; all logged-in devices and API keys share the quota.
- **Kimi consumer Terms** (effective Jan 5, 2024): "you may only use Kimi in a non-commercial, personal research, and study manner" (https://www.kimi.com/user/agreement/en/modelUse). Older than the guidelines and in tension with commercial relay.
- **Kimi Open Platform Terms** (Last Updated July 30, 2026; API, pay-as-you-go): customer may integrate into Customer Applications offered to End Users, but "must not share your account credentials", and may not "buy, sell, or transfer API keys from, to or with a third party" (https://platform.kimi.ai/docs/agreement/modeluse).
- **Private**: tolerated in official-compatible local tools; a hosted relay of one person's key is not addressed and sits close to "reverse proxy" and "resell as a service". **Shared**: prohibited.

### Meta

- **Meta Model API Terms of Service**, last updated Oct 9, 2026 (https://dev.meta.ai/legal/terms-of-service):
  - §3.1: "You may not share, sell, or transfer your Meta Model API key with any third party without our prior written permission."
  - §3.2 **Coding Harness Subscription** (Muse Code): the credential "is for use only with the coding harness ... and may not be used to access the Services outside the coding harness or to circumvent your subscription's usage limits or billing."
  - Restrictions list: no "access or use [of] the Services on behalf of any third party"; "you may not resell, or otherwise provide access to the Services (including the Meta Models or any Meta Model API key) to any third party on a standalone basis, or through any model aggregator, API gateway, proxy, or similar offering, in each case except as expressly authorized by Meta in writing".
  - Developers may build Integrated Products that let End Users interface with the Services.
- Meta One consumer subscriptions launched Sept 15, 2026 (https://about.fb.com/news/2026/09/introducing-meta-one-subscription-service-more-features-ai/). I could not read the consumer Meta AI terms (https://www.facebook.com/legal/ai-terms returned an error to the fetcher) or the Meta Subscription Terms of Service, so consumer-plan rules are unconfirmed.
- **Private**: harness-bound credential, so not usable through a gateway; API route requires Meta's written authorisation for a gateway. **Shared**: prohibited.

### Devin / Cognition

- **Platform Terms of Service**, last updated June 30, 2026 (https://cognition.com/legal/platform-terms-of-service): right to use is "non-sublicensable, non-transferable" for "internal business purposes only, solely for use by you and your Authorized Users" (§2.1).
- **Acceptable Use Policy**, last updated June 30, 2026 (https://cognition.com/legal/acceptable-use-policy): "users must not provide other users with access to their account or their account credentials"; "Users must not reproduce, duplicate, copy, sell, or resell any portion of our Services."
- **Integration route**: the Devin API uses service users (and `create_as_user_id` to create sessions on behalf of org members, with RBAC and audit) or personal access tokens (https://docs.devin.ai/api-reference/overview).
- I found no Devin/Windsurf program for relaying a subscription through a third-party service. Devin is an agent product rather than a raw model credential, so it is likely a different integration shape (Agents area) than the others.

## Cross-cutting observations

- Every consumer-account text read forbids sharing credentials and making the account available to others (Anthropic, OpenAI, xAI, Cognition; Kimi's guidelines via "reverse proxy"). A shared credential is therefore not supportable on consumer or subscription plans.
- Provider direction in 2026 is toward **provider-built delegated flows**: OpenAI's per-app plan sharing with user-set caps; Anthropic's separate credits for programmatic use; xAI/Kimi's named client integrations; Meta's harness-bound credential. The common theme is that the provider controls the client or the metering.
- "Interactive/ordinary individual use" recurs (Anthropic, Kimi, Google CLI/Antigravity): a gateway that performs automated, multi-user, or non-interactive calls is at risk even when each token belongs to its user.
- Google has banned accounts at scale and later offered remediation; Kimi and Anthropic state graduated consequences. Account termination risk lands on the member whose subscription it is.

## Options and trade-offs (not a decision)

- **Private subscription credentials**: allow all providers (highest risk, Anthropic and Google explicitly prohibit); allow only providers with a sanctioned path (OpenAI plan program; maybe xAI/Kimi, subject to written confirmation); or run subscription logins only in the member's own client/self-hosted instance and keep Cloud to API keys.
- **Shared credentials**: restrict to API keys and cloud-provider credentials; if a subscription credential is marked shared, block or warn.
- **Ask providers in writing** (Anthropic partnerships, xAI, Moonshot, Meta) for authorisation; Meta and Anthropic explicitly allow exceptions "in writing" / "otherwise explicitly permit".
- Warnings or per-provider flags in the UI so the org owner takes the compliance responsibility are an option; terms still bind the member, not the proxy.

## Not confirmed / gaps

- xAI enterprise terms and FAQ, Meta consumer AI terms and Meta Subscription terms, and Anthropic/OpenAI/Google *team-plan seat-sharing* text were not read in full (fetch blocked or not found).
- OpenAI partner onboarding requirements were not found; the partner directory was not opened.
- Anthropic's legal page and support pages disagree on third-party apps; no single dated reconciliation exists.
- Several pages show no date (Anthropic Claude Code legal page, Kimi guidelines); dates above are as displayed, or "no date shown".
- Terms change often (several changed in the last 30 days: xAI Oct 12, Meta Oct 9, OpenAI help page about Oct 8). Re-check before launch.
- This is research, not legal advice.
