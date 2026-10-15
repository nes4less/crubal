# The backbone map

Three boards drawn while designing the 2.0 backbone (2026-10-15), kept here as the source of the design
canvas. The live, editable canvas is at https://claude.ai/artifact/4HV1a1XVsaDRHFQxB8ZuNz; these files are
what it holds, and they open in any browser as they are.

| Board | Shows |
|---|---|
| [Main.dc.html](Main.dc.html) | the tools and how they connect: callers, the host, the core (border, log, migrations, records, views, bindings, record index, projection stream) and the indexes that serve views |
| [Lifecycle.dc.html](Lifecycle.dc.html) | a record's life: arrival, active (attached or standing alone), pending instructions, archive and cascade |
| [Access.dc.html](Access.dc.html) | access as edges over a nesting of records, with modes, the grantor chain, relations and the owner's key |

`canvas.json` is the canvas index: each board's frame and the order they sit in.

Named tools and parties on the boards (a bench app, a marketplace, a platform tenant, a sports facility) are
examples, as they are in the spec (README, Conventions). The core defines none of them. The boards follow
the spec chapters they draw: 1.12, 7, 8.5, 9.2a, 10.7, 12.6 and 14; when a board and a chapter disagree,
the chapter is right and the board is behind.
