# The Responses WebSocket lives in the request that accepted it

A client's Responses WebSocket keeps its state in the Worker invocation that accepted it, not in a durable object. A hibernating durable object would add a round trip for every frame, and it could not hibernate anyway while it holds an open upstream socket. A deploy therefore drops live sockets, and clients reconnect and resend their full input.
