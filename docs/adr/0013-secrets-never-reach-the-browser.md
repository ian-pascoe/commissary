# Secrets never reach the browser

Provider tokens and API keys stay on the server.

- **Reads:** the browser sees only short previews and secret placeholders.
- **Edits:** existing keys are addressed by auth index.
- **Provider calls:** quota checks, reset claims and key tests are made by the server, not the browser.
- **Writes:** a write never confirms a guessed secret. A placeholder is valid only at its own position, and a typed duplicate of a stored key is dropped silently. Error messages never quote values.

The Go server's panel reads raw keys and can substitute stored tokens into arbitrary requests. Those routes are masked or not ported. Two things are lost: lossless round trips of Go documents through the Go-shaped routes, and some Go scripts.
