# 15. Acts

An **act** is what a utility does to a record when a person presses it: file a unit, print its label, pick an
order. Chapter 11.1 names a utility's acts; chapter 12.10 lets a lane's press name one; chapter 12.11 makes a
flow's stop of one, and its lane's `done` the stamp it leaves. Until revision 25 what an act did lived in the
app alone. This chapter lets a package say it (revision 26 adds a route through a rack of rules, a mint when a
find comes up empty, a series, and an act standing in for another), so a place may draw an act of its own as it draws a flow or a
print, and the app keeps only the transports.

## 15.1 The declaration

```crubal
act: file /2026-11-09
  utility: bench
  label: File
  on: unit
  context: station
  route:
    slot -> row of context.station.slots by slotRule over record, record.of keep keep by unit where of = record.of, filedSlot = slot.slotName, filedIn.containerStation = context.station
  find:
    box -> first container where containerStation = context.station, containerSlot = slot.slotName, containerState = open order containerLabel
  mint:
    box -> container when none
      containerLabel -> next slot.boxPrefix in container.containerLabel, slot.boxSuffix
      containerStation -> link station
      containerSlot -> slot.slotName
      containerLocation -> context.station.stationLocation
      capacity -> slot.boxCapacity
      containerState -> open
  set:
    filedIn -> link box
    filedBox -> box.containerLabel
    filedSlot -> slot.slotName
    filedAt -> now
  then:
    when box.containerCount + 1 >= box.capacity set box.containerState = full, box.filledAt = now send notify containerFull about context.station

act: label /2026-11-08
  utility: bench
  label: Print the label
  on: unit
  context: station
  send: print context.station.unitPrint at context.station
  lands: when the send reports

act: fileByCategory /2026-11-09
  utility: bench
  replaces: file
  on: unit
  context: station
  …
```

| Setting | Holds |
|---|---|
| `act` | its name (a lower-case word) and dated version; a member like a lane, listed in `members`; the utility's `acts:` names it, or it `replaces` one the utility names |
| `utility` | the utility the act belongs to |
| `replaces` | revision 26: the act of the same utility this one stands in for; a lane's press and a flow's stop naming that act run this one; the utility's `acts:` need not name the replacing act |
| `label` · `describe` | its words on a screen |
| `on` | the level it acts on: the record in hand |
| `context` | kinds the act holds beside the record, asked once and kept per person (12.11's `context:`): `context.<kind>` in its lines names the record held, `context.<kind>.<facet>` (revision 26) reads its facet |
| `route` | revision 26, one line: `<name> -> row of <ref> by <column> over record[, record.<link facet>] [keep <column> by <kind> where <picks>]`: the rows of a compound facet on a record (`context.station.slots`, the station's rack), each row's `<column>` a condition (6.3) read over the record in hand's values laid over the linked record's (`record.of`, the product's); the first row whose condition holds is taken; the last row takes what no row above claimed, its condition unread; with `keep`, a row whose count (the records of the kind the picks admit) is its `<column>` or more is passed over. `<name>.<column>` thereafter reads the row taken; in the count's picks it reads the row being weighed |
| `find` | one line per find, `<name> -> first\|all <kind> [where <facet> = <value>, …] [order <facet> [after\|before]]`: the records of a kind the picks admit, in the order said, the first or all; a pick's facet may be a link facet's target's, `<link facet>.<facet>` (revision 26, one hop); a pick's value is a literal, `record.<facet>` (the record in hand's), `context.<kind>` (the context record's id), `context.<kind>.<facet>`, `<found>.<facet>` (an earlier find's) or `<route>.<column>` (the row taken) |
| `mint` | revision 26: under a find's name, `<found> -> <kind> when none`, then set lines beneath it: when the `first` find answered nothing, a record of the kind is made with these values, through its make form as the act's own source, and stands as what the find found |
| `set` | one line per write on the record in hand, `<facet> -> <source>`: a literal, `link <found\|context>` (a link to the record found or held), `<found>.<facet>`, `<route>.<column>`, `context.<kind>.<facet>` or `record.<facet>` (a value copied), `now` (the moment), or `next <ref> in <kind>.<facet>[, <ref>]` (revision 26: the next label in a series: the prefix, one more than the highest number the kind's facet carries after that prefix, three digits, then the suffix when given) |
| `then` | one line per conditional write on records found, `when <term> <op> <term> set <found>.<facet> = <value>[, <found>.<facet> = <value>…] [send <verb> <words>]`: a term a reference or a number, with `+ n` added to a reference; the ops `=`, `<`, `>`, `<=`, `>=`; the writes on every record the find answered, a value a literal or `now` (revision 26); the send run only when the condition held |
| `send` | a transport verb the app provides (`print`, `notify`, `charge`, `ship`), then its words, carried unchanged for the app to read |
| `lands` | when the act counts as landed, and its lane's stamp is written (12.11): `now` (the default), or `when the send reports` |

## 15.2 What the engine does, and what the app does

The engine reads, checks and carries the act, and answers, pure, each step the app runs: **the row a route
takes** given the rows and the values (the counts the app answered for its `keep`), **the picks of a find** as
they stand, **the values a mint makes** given the labels the series reads, and **the writes a landing makes**:
given the record in hand, the context records, the row taken and what each find answered or minted, the values
each `set` writes on the record and each `then` writes on the records found, in the order written, with the sends
the thens that held carry; a `first` find that answered nothing and mints nothing stops the act before any write,
with the reason. The app runs the finds and counts against its store, makes the mints and the writes through the
records' forms as the act's own source (chapter 8), runs the sends through the transports it provides, and stamps
the lane when the act lands (12.11). An act with no declaration keeps the body the app gives it; a declared act
stands in place of the body; an act that `replaces` another stands in place of that one.

A send is the app's: which verbs exist, what their words mean, and when they report are not the engine's to
say.

## 15.3 Well-formed acts

A package MUST be refused at publish when an act names a utility it doesn't declare or one that neither lists it
among its acts nor lists the act it `replaces`; replaces itself; is `on` no level; names a context that is no kind;
routes over no compound facet, by a column the compound lacks, or over a link facet the level lacks; finds, counts
or mints a kind the package lacks; picks, orders by, sets, mints or reads a facet the package lacks (a route's
column the compound's); names a find, route or context it did not declare; sets one facet twice; finds one name
twice; mints a find that takes `all`; or lands when the send reports and sends nothing. As a flow's (12.11), a
package that extends others may name their utilities, kinds and facets: what the file-local check cannot see it
leaves to the check of the packages in force together (11.4, at install), which refuses as the publish would have.

## 15.4 The JSON form

An act is `{"act", "version", "utility", "replaces", "label", "describe", "on", "context": [...], "route": {"name",
"rows": reference, "by", "over": [reference…], "keep": {"column", "kind", "where": [pick…]}}, "finds": [{"name",
"take", "kind", "where": [{"facet", "value": {"literal"} | reference}], "order": {"facet", "dir"}, "mint": {"kind",
"sets": [set…]}}], "sets": [{"facet", "source": {"literal"} | {"link"} | {"now": true} | {"next": {"prefix":
reference, "in": {"kind", "facet"}, "suffix": reference}} | reference}], "thens": [{"when": {"left", "op", "right"},
"sets": [{"found", "facet", "value": {"literal"} | {"now": true}}], "send": {"verb", "words"}}], "send": {"verb",
"words"}, "lands"}` under `acts`; a reference is `{"record"} | {"context"} | {"context", "facet"} | {"found",
"facet"} | {"route", "column"}`; a pick's facet may be `"<link>.<facet>"`. An act holds no value on any record:
retiring one is a safe change (10.5). A reader that doesn't know the act carries it unchanged (13.5).
