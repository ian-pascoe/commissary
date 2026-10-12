# Cooldowns are always persisted

The Go server saves cooldowns only when `save-cooldown-status` is set, because otherwise they last exactly as long as its process. On Workers the ControlPlane is evicted after a few seconds idle, and an eviction cannot be told apart from a deploy. Cooldowns are therefore always saved, and the setting is a not-applied key. Honouring the setting was tried first: a model the provider had refused (OpenCode "Model access is disabled") was picked again after the first idle gap.
