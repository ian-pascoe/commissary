# Run the proxy on Cloudflare Workers

The proxy is a rewrite of the Go server for Cloudflare Workers: a stateless Worker, with durable objects, KV and D1 for the state. Running the Go server as it is on a host was the other option. Workers won because they are cheap, run at the edge everywhere, and leave no server to maintain.

## Consequences

The proxy accepts Workers' limits:

- requests leave from Cloudflare's addresses;
- there is no TLS or HTTP/2 fingerprint control and no outbound proxy;
- waits and retries are bounded;
- a Responses WebSocket is bounded by the Workers CPU limit.
