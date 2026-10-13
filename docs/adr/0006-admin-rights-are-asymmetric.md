---
status: superseded by ADR-0022
---

# Deployment admins come first; only service-token admins hold the sensitive powers

Admins are named by the deployment's variables, by the config document, or by both. Deployment admins are checked first and need no stored state, so they can always repair a broken config document. Two powers need a service-token admin or a deployment admin: downloading a stored credential, and changing the config document's list of service-token admins. A person's browser session is the most exposed way in, and it must not be able to grant itself the right to download tokens.
