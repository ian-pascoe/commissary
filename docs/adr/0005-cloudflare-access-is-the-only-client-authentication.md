# Cloudflare Access is the only client authentication

Every request is authenticated by Cloudflare Access. People sign in through the identity provider, and clients use their own service tokens. The principal replaces the Go server's client keys for attributing usage and isolating sessions. Client keys from Go documents are accepted on import but never enforced, and there is no management key. The Worker has no address outside the Access hostname, so Access cannot be bypassed.

## Consequences

The Access cookie is sent by browsers automatically, so the proxy adds defences Go did not need:

- it refuses cross-site state-changing requests and cross-origin WebSocket upgrades;
- management writes must have a JSON body;
- management answers carry no CORS headers.
