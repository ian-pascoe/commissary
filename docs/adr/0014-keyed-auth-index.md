# The auth index is keyed with a secret held by each stage

The Go server derives a credential's public index from an unsalted hash, so anyone who has the index can confirm guesses of an API key offline. Here the index is computed from the credential with a secret key held by each stage. It is never stored, and internal credential ids never leave the Worker. Setting or rotating that key changes every auth index once, which breaks saved panel links and the joins external collectors make on old exports.
