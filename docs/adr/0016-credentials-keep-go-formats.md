---
status: partly superseded by ADR-0025
---

# Credentials keep the Go server's formats

An account is stored as the Go server's auth file, verbatim, including keys the proxy does not know. API keys are not stored as credentials. They are derived from the config document and take ids computed from their content, the same ids the Go server computes, so editing a key makes it a new credential. Migrating from the Go server is therefore uploading the same files and importing the same document. The cost is a loose document format instead of a typed schema: settings and tokens are separated by known key names.
