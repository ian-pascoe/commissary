# Compaction capsules are sealed with the Go server's fixed key

On providers without native compaction, compacted history is returned to the client as a sealed capsule. The capsule is encrypted with the fixed key the Go server uses. Capsules therefore work across Go servers and across this proxy's deployments. The encryption is obfuscation, not secrecy. A per-deployment key would break every capsule already held in client histories, and would break interoperability with the Go server.
