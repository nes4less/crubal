# 15. Acts

An **act** is what a utility does to a record when a person presses it: file a unit, print its label, pick an
order. Chapter 11.1 names a utility's acts; chapter 12.10 lets a lane's press name one; chapter 12.11 makes a
flow's stop of one, and its lane's `done` the stamp it leaves. Until revision 25 what an act did lived in the
app alone. This chapter lets a package say it, so a place may draw an act of its own as it draws a flow or a
print, and the app keeps only the transports.

## 15.1 The declaration

```crubal
act: file /2026-11-08
  utility: bench
  label: File
  on: unit
  context: station
  find:
    box -> first container where containerStation = context.station, containerState = open order containerLabel
  set:
    filedIn -> link box
    filedBox -> box.containerLabel
    filedAt -> now
  then:
    when box.containerCount + 1 >= box.containerCapacity set box.containerState = full

act: label /2026-11-08
  utility: bench
  label: Print the label
  on: unit
  context: station
  send: print context.station.unitPrint to context.station.printer
  lands: when the send reports
```

| Setting | Holds |
|---|---|
| `act` | its name (a lower-case word) and dated version; a member like a lane, listed in `members`; the utility's `acts:` names it |
| `utility` | the utility the act belongs to |
| `label` · `describe` | its words on a screen |
| `on` | the level it acts on: the record in hand |
| `context` | kinds the act holds beside the record, asked once and kept per person (12.11's `context:`): `context.<kind>` in its lines names the record held |
| `find` | one line per find, `<name> -> first\|all <kind> [where <facet> = <value>, …] [order <facet> [after\|before]]`: the records of a kind the picks admit, in the order said, the first or all; a pick's value is a literal, `record.<facet>` (the record in hand's), `context.<kind>` (the context record's id) or `<found>.<facet>` (an earlier find's) |
| `set` | one line per write on the record in hand, `<facet> -> <source>`: a literal, `link <found\|context>` (a link to the record found or held), `<found>.<facet>` or `record.<facet>` (a value copied), or `now` (the moment) |
| `then` | one line per conditional write on records found, `when <term> <op> <term> set <found>.<facet> = <value>`: a term a reference or a number, with `+ n` added to a reference; the ops `=`, `<`, `>`, `<=`, `>=`; the write on every record the find answered |
| `send` | a transport verb the app provides (`print`, `charge`, `ship`, `notify`), then its words, carried unchanged for the app to read |
| `lands` | when the act counts as landed, and its lane's stamp is written (12.11): `now` (the default), or `when the send reports` |

## 15.2 What the engine does, and what the app does

The engine reads, checks and carries the act, and answers **the writes a landing makes**: given the record in
hand, the context records and what each find answered, the values each `set` writes on the record and each
`then` writes on the records found, in the order written; a `first` find that answered nothing stops the act
before any write, with the reason. The app runs the finds against its store (the picks resolved by the engine's
own reading of them), makes the writes through the record's form as the act's own source (chapter 8), runs the
send through the transport it provides, and stamps the lane when the act lands (12.11). An act with no
declaration keeps the body the app gives it; a declared act stands in place of the body.

A send is the app's: which verbs exist, what their words mean, and when they report are not the engine's to
say. What a declaration cannot say stays a body: a record minted by the act (a new box from a series when the
rack's box is full) is the first thing a later revision adds.

## 15.3 Well-formed acts

A package MUST be refused at publish when an act names a utility it doesn't declare or one that doesn't list it
among its acts; is `on` no level; names a context that is no kind; finds a kind the package lacks; picks, orders
by, sets or reads a facet the package lacks; names a find or a context it did not declare; sets one facet twice;
finds one name twice; or lands when the send reports and sends nothing. As a flow's (12.11), a package that
extends others may name their utilities, kinds and facets: what the file-local check cannot see it leaves to the
check of the packages in force together (11.4, at install), which refuses as the publish would have.

## 15.4 The JSON form

An act is `{"act", "version", "utility", "label", "describe", "on", "context": [...], "finds": [{"name", "take",
"kind", "where": [{"facet", "value": {"literal"} | {"record"} | {"context"} | {"found", "facet"}}], "order":
{"facet", "dir"}}], "sets": [{"facet", "source": {"literal"} | {"link"} | {"now": true} | reference}], "thens":
[{"when": {"left", "op", "right"}, "set": {"found", "facet", "value"}}], "send": {"verb", "words"}, "lands"}`
under `acts`. An act holds no value on any record: retiring one is a safe change (10.5). A reader that doesn't
know the act carries it unchanged (13.5).
