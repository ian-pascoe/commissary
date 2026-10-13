---
status: accepted
---

# Org configuration is stored as entries, not as one document

An org's configuration is no longer one versioned document. Every setting, key group, API key, model rule and payload rule is a config entry of its own: a row in the org's ControlPlane database, created, changed and deleted on its own. Each write names the revision of the entry it changes, so two org admins editing different things no longer conflict, and a write based on an older revision of the same entry is refused. Members, teams, grants, proxy keys, spend limits and price overrides are entries in the same database.

A single document worked for one person editing their own proxy. With many members, some entries are private (a member's API key), some are edited by different admins at the same time, and permissions differ per kind of entry. A document has one owner and one version; entries can each have their own.

## Considered Options

- Keeping the document and adding private sections to it. Every write would still conflict with every other, and hiding a member's private keys from the org admins who edit the document would mean filtering the document on every read and merging it back on every write.
- D1 instead of the ControlPlane's own database. D1 would allow queries across orgs, but every selection would wait on a network round trip, and D1 would become a second writer beside the ControlPlane (ADR 0021). Configuration is only ever read and written within one org.

## Consequences

- The raw configuration editor, secret placeholders and the Go-shaped `/config*` and `/config.yaml` routes are removed. The control panel edits each entry with its own form.
- A Go config document can still be imported: the import turns it into entries once. Not-applied keys are named by the import and not stored, which replaces their round trip from ADR 0015.
- An API key keeps its credential id when its secret is edited, so the edit no longer creates a new credential. This replaces the API key half of ADR 0016; accounts keep the Go auth file format.
- A private API key is an entry owned by its member (ADR 0023), so org admins never receive its secret, its base URL or its headers.
- The `global` org's stored document is turned into entries the first time the ControlPlane starts with the new schema. The document is kept until the import has succeeded.
- Code that reads settings keeps one in-memory view of the org's entries. A counter of changes per org tells each Worker isolate when to rebuild its view, as the config version does now.
