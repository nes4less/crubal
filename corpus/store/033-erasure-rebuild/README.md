# Erasure leaves the shell (8.5.2, 8.5.3)

A signup entry created C-1 and wrote their name and email in one transaction. Their email was erased: the
email write in L-1 is redacted in place, and L-2, which held nothing but the new email, is redacted whole.
Rebuilding gives C-1 with its name and the later note and no email at all: the creation was never redacted,
so no later write dangles.
