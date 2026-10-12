# Payload rules are the last change to every upstream body

Every provider path applies the operator's payload rules after translation, thinking and provider shaping. Nothing may change the body after the rules, except Claude's body signing, which must cover the final bytes. The operator's rules therefore always win over the proxy's own adjustments. Some fix-ups ported from Go would run after the rules; they are deliberately not called.
