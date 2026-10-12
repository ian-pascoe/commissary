---
status: accepted
---

# The Go server is a reference, not the authority

This replaces ADR 0002. The port stands on its own, and following the Go server everywhere now costs more than it gives: the model catalog is the first place where Go's answer is worse than one we can choose ourselves. From now on, the Go server is a source of ideas and of tested behaviour that the proxy copies by choice. A difference from Go is an ordinary design decision. It only gets an ADR when it meets the usual bar.

## Consequences

- Changes in the Go server are candidates to port, not obligations. Upstream drift is picked from, not caught up on.
- A golden fixture that changes after a reference update shows a change to consider, not one that must be ported. Fixtures stay where the proxy still matches Go on purpose.
- Existing "Go source" citations and deviation notes stay as history. New code cites Go only where it actually copies Go.
- Compatibility with documents from the Go server (config, credentials) is kept where it is cheap, not as a rule.
