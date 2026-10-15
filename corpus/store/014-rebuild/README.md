# Rebuild from the log alone (8.5.3)

The log records effects (8.5): value writes with their source and where they landed (current, alternative,
held), envelope writes (created, status, applied), a binding, an edge, an instruction, a run and an install.
Applying the five entries to an empty store gives exactly this state, with no rules and no package. Links
are not checked here; `prev` is a placeholder.
