# The Go server is the behavioural reference

The proxy reproduces the Go server's behaviour, and every intentional difference is recorded as a deviation. The Go code is not part of this repository. It lives only as a read-only reference checkout, and golden fixtures are recorded by running that code. Ported modules keep the Go file structure and cite their Go source, so a change in the Go server can be ported mechanically. A fixture that changes after the reference is updated is a change to port, never noise.

## Considered Options

- Keeping the Go tree in the repository, as the fork did at first. It was removed once the port stood on its own.
- Hand-written expected results, which drift from the real behaviour unnoticed.
