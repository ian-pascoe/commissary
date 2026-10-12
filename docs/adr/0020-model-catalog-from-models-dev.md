---
status: accepted
---

# The model catalog comes from models.dev plus catalog additions

The proxy no longer takes its model catalog from the Go server's catalog source. Every provider's catalog is derived from models.dev, which OpenCode Zen and OpenCode Go already used: one shared download, refreshed periodically, with a trimmed copy shipped with the proxy for a fresh deploy. What models.dev lacks is kept in catalog additions that the proxy owns and edits. These are models that models.dev does not list, such as the Codex plans, Antigravity and Devin, and facts the proxy needs about a model that models.dev does not carry. They were seeded once from the Go catalog, and are maintained here from then on. An addition only fills a gap: where models.dev has a value, it wins, and a wrong value is fixed at models.dev rather than overridden here.

## Considered Options

- Keep fetching the Go catalog for the providers models.dev does not cover. This leaves a live dependency on the Go project, which ADR 0019 ends.
- Drop the models models.dev does not list. Codex plans, Antigravity and Devin would lose most of their models.
- Let additions override models.dev values. Overrides go stale silently. The case that prompted it, a smaller Codex context window, turned out to be a client default rather than a limit.

## Consequences

- A provider offers every current text model models.dev lists for it, except those its route cannot serve. New models appear without a change here.
- Limits follow models.dev and differ from the Go catalog's for some models. For example, Codex models' context windows grow to models.dev's figure.
- Model prices from models.dev are left out for now.
