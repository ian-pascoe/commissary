---
status: superseded by ADR-0021
---

# One ControlPlane object owns all mutable state

A single durable object, the ControlPlane, is the only writer of the config document, the credentials and their cooldowns, login sessions, and allowance and reset-grant state. Every request asks it for a credential and reports back the outcome. Its single-threaded execution replaces the Go server's locks and background loops, and versioned writes to the config document replace rewriting a file. The trade-off is that one global object handles every request: correctness and simplicity were chosen over horizontal scale. Slow provider calls, such as quota checks, run in the Worker so that the ControlPlane is not blocked.

## Considered Options

- KV, which cannot do atomic read-modify-write.
- D1, which is kept for usage records.
