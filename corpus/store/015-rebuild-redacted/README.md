# A redacted entry leaves the state without what it held (8.5.2, 8.5.3)

L-2 is redacted: only its hash remains, so whatever it wrote is gone from the rebuilt state, while L-1 and
L-3 still apply. A record's creation is never redacted, so no later write dangles.
