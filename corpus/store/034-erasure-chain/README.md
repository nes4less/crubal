# The chain holds through an erasure (8.5)

The same log as 033. An entry's hash covers each write through the write's own hash, so L-1 hashes the same
with its email write replaced by that hash, L-3's `prev` still matches L-2's carried hash, and the links
check out.
