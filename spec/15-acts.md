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
  count:
    boxed -> unit where filedIn = box
  set:
    filedIn -> link box
    filedBox -> box.containerLabel
    filedSlot -> slot.slotName
    filedAt -> now
  then:
    when boxed + 1 >= box.capacity set box.containerState = full, box.filledAt = now send notify containerFull about context.station

act: label /2026-11-08
  utility: bench
  label: Print the label
  on: unit
  context: station
  send: print context.station.unitPrint at context.station
  lands: when the send reports

act: file /2026-11-12
  utility: bench
  …
  tells: post as filed
    sender -> owner
    postAbout -> link record
    actRun -> run
    postedAt -> now
    visibility -> public

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
| `takes` | revision 35: `share`, where the level's kind declares its quantity (11.2 `shares`): the act may land on fewer than the record holds. The one running it gives a count, all of it when none is given. Fewer **splits** the record (15.2) and the act lands on the share taken |
| `context` | kinds the act holds beside the record, asked once and kept per person (12.11's `context:`): `context.<kind>` in its lines names the record held, `context.<kind>.<facet>` (revision 26) reads its facet |
| `needs` | revision 42: one line per need, `<facet>` or `no <facet>`, with its words in quotes after it or not: what the record in hand must hold, or lack, for the act to land. The facet is the record's own, or `<link facet>.<facet>`, the facet of the record it links to (one hop; the host hands the linked record, and one that links to nothing holds nothing). Read before anything else; the first that fails stops the act before any write, with its words (or "`<facet>` is not set", "`<facet>` is already set") as the reason |
| `given` | revision 44: one line per value the act is given by the person pressing it, `<name> as <facet>`, with its words in quotes after it or not, then `from <ref>` or `default <value>` or neither. The facet is the given's type: what asks for it (a number, money, a choice) and what refuses it are the facet's own. `from record.<facet>` or `from context.<kind>.<facet>` is what the question **opens on** (a count opened on what is expected); `default <value>` is what the given takes when the person says nothing, and a given with a default need not be asked. `given.<name>` reads it wherever a reference may stand: a set's or a mint's source, a then's value, a `when`'s term, a pick's value |
| `route` | revision 26, one line: `<name> -> row of <ref> by <column> over record[, record.<link facet>] [keep <column> by <kind> where <picks>]`: the rows of a compound facet on a record (`context.station.slots`, the station's rack), each row's `<column>` a condition (6.3) read over the record in hand's values laid over the linked record's (`record.of`, the product's); the first row whose condition holds is taken; the last row takes what no row above claimed, its condition unread; with `keep`, a row whose count (the records of the kind the picks admit) is its `<column>` or more is passed over. `<name>.<column>` thereafter reads the row taken; in the count's picks it reads the row being weighed |
| `of` | a record's parent (1.1), no facet: it stands where a facet may (`record.of`, a route's `over`, a pick's facet `of = record.of`) and the dictionary is never asked for it |
| `find` | one line per find, `<name> -> first\|all <kind> [where <facet> = <value>, …] [order <facet> [after\|before]]`: the records of a kind the picks admit, in the order said, the first or all; a pick's facet may be a link facet's target's, `<link facet>.<facet>` (revision 26, one hop); a pick's value is a literal, `record.<facet>` (the record in hand's), `context.<kind>` (the context record's id), `context.<kind>.<facet>`, `<found>.<facet>` (an earlier find's), `<found>` alone (its id, revision 26), `caller` (revision 35: the person running the act, as `link caller` is in a set), `record` alone (revision 39: the record in hand, its id, so `of = record` finds the records beneath it and `<link facet> = record` those that link to it; the word itself as a literal is written quoted) or `<route>.<column>` (the row taken) |
| `count` | revision 26: one line per count, `<name> -> <kind> [where <picks>]`: how many records of the kind the picks admit, for a `then` to read by name; a pick's value may be a found record's bare name, its id |
| `mint` | revision 26: under a find's name, `<found> -> <kind> when none`, then set lines beneath it: when the `first` find answered nothing, a record of the kind is made with these values, through its make form as the act's own source, and stands as what the find found |
| `set` | one line per write on the record in hand, `<facet> -> <source>`: a literal, `link <found\|context>` (a link to the record found or held), `<found>.<facet>`, `<route>.<column>`, `context.<kind>.<facet>` or `record.<facet>` (a value copied), `now` (the moment), `link caller` (revision 29: a link to the person running the act), `none` (revision 29: the facet cleared), `next <ref> in <kind>.<facet>[, <ref>]` (revision 26: the next label in a series; revision 35: the prefix MAY be the words themselves, quoted, `next "PULL" in pull.pullLabel`: the prefix, one more than the highest number the kind's facet carries after that prefix, three digits, then the suffix when given), or, revision 31, `owner` (the owner the act lands at, as text), `run` (the act run's id) and `link record` (a link to the record in hand), or, revision 45, a **sum**: `<a> + <b>` or `<a> - <b>`, each a reference or a number and at least one a reference (`given.count - record.qty`, `record.movedCount + 1`), written as a number; words that read like a sum are a literal when quoted; or, revision 46, `caller` alone: the person running the act as words (their id), for a text facet that says who and may also hold a name that is no person; the word itself as a literal is written quoted |
| `make` | revision 45: one line per record the act makes when it lands, `<name> -> <kind> [when <term> <op> <term> [and …]]`, its set lines beneath as a mint's: a record of the kind with these values, made through its make form as the act's own source, whatever the finds answered. With a `when`, only where it holds. Its sources read the record in hand **as it stood** before the act's writes, so `given.count - record.qty` is the difference the act makes |
| `then` | one line per write on records found, `[when <term> <op> <term>] set <found>.<facet> = <value>[, <found>.<facet> = <value>…] [send <verb> <words>]`: a term a reference, a count's name or a number, with `+ n` added to a reference or a count; the ops `=`, `<`, `>`, `<=`, `>=`; the writes on every record the find answered; a value a literal or `now` (revision 26), or (revision 39) a set's own: `link <found\|context>`, `link record`, `link caller`, a reference (`record.<facet>`, `context.<kind>.<facet>`, `<found>.<facet>`, `<route>.<column>`: a value copied, read once and written on each) or `none` (the facet cleared); the send run only when the condition held. With no `when` (revision 39) the writes are made whenever the act lands. Revision 45: the ops gain `!=`; a `when` may join comparisons with `and`, all of which must hold; a value may be a sum, as a set's; and `record.<facet>` names the record in hand as what is written on, over what the act's sets wrote (a write the act makes only where a condition holds). Revision 46: a value may be `caller`, as a set's. Revision 47: a comparison may be `has <ref>` (the reference holds a value) or `no <ref>` (it holds none); and in place of `set …` a then may say `archive <record\|found> [as <reason>]` or `restore <record\|found>`: the standing (chapter 8) of the record in hand or of every record the find answered, read on each where the condition reads that find |
| `also` | revision 47: one line per act run when this one has landed, `[<utility>/]<act> on record\|<found> [when …]`: the act of this utility, or of the one named, run on the record in hand or on each record the find answered, where the condition holds (read on each where it reads that find, and as the record in hand stood before this act's writes) |
| `send` | a transport verb the app provides (`print`, `notify`, `charge`, `ship`), then its words, carried unchanged for the app to read |
| `lands` | when the act counts as landed, and its lane's stamp is written (12.11): `now` (the default), or `when the send reports` |
| `tells` | revision 31: `<kind> as <aspect>`, its set lines beneath as a mint's: the **post** the act lands when the record in hand, or any of its ancestors, is followed (14.10). The kind is the post's (a kind of the package or one in force); the aspect is one a kind declares under `follow:` (11.2), what a follower chose to hear. At the landing the app asks for the live `follower` edges on the record and its ancestors; with none, nothing is made; with any, **one** record of the kind is made with these values through its make form, as the act's own source, whatever the number of followers, and **within the record in hand**, so its ancestors are the record's and a view of posts partitioned by `relation follower` (12.6, 14.10) serves it to whoever follows the record or what it is of. The sources are a set's; `owner`, `run` and `link record` name the sender, the run and the subject. A post is a record like any other: the follower's feed is a view over it |

## 15.2 What the engine does, and what the app does

The engine reads, checks and carries the act, and answers, pure, each step the app runs: **the row a route
takes** given the rows and the values (the counts the app answered for its `keep`), **the picks of a find or a count** as
they stand, **the values a mint makes** given the labels the series reads, and **the writes a landing makes**:
given the record in hand, the context records, the row taken and what each find answered or minted, the values
each `set` writes on the record and each `then` writes on the records found, in the order written, with the sends
the thens that held carry; a `first` find that answered nothing and mints nothing stops the act before any write,
with the reason. The app runs the finds and counts against its store, makes the mints and the writes through the
records' forms as the act's own source (chapter 8), runs the sends through the transports it provides, and stamps
the lane when the act lands (12.11), and, when the act `tells` and a follower stands on the record or an ancestor
(14.10), makes the one post the engine answers (`tellsValuesOf`) through its make form. An act with no declaration
keeps the body the app gives it; a declared act stands in place of the body; an act that `replaces` another stands
in place of that one.

A send is the app's: which verbs exist, what their words mean, and when they report are not the engine's to
say.

**Reaching the records around the one in hand (revision 39).** An act on a whole reaches its parts by a
find whose pick is `of = record`, and an act on a record reaches those that link to it by `<link facet> =
record`; a `then` with no condition writes on every one of them, and its value may be a link, a value
copied or `none`. So "close every part of this whole", "mark every member of this group as entered" and
"move every member of this group to that one" are each an act's declaration. A then's clears are answered
beside its values (`clear` on the found record's writes) and taken off as the record's own are; a value a
reference reads nothing for writes nothing. Where two thens write one facet of one record, the later
stands, a clear as much as a value.

**What an act is given (revision 44).** Some presses need a value from the person: a price, a count, how many
to add. An act says so itself, so the question is asked wherever the act is pressed (a card, a scan, a case's
answer, a cart) and never lives in one screen:

```crubal
act: reprice /2026-11-15
  utility: products
  on: offer
  given:
    price as price "What price?" from record.price
  set:
    price -> given.price
```

The app asks for each given by its facet, opened on its `from`; `givenOf` answers, pure, what was said with the
defaults laid under it, which are still to ask, and what each question opens on. The act lands only with every
given in hand: `actWrites` refuses with "`<name>` is not given" before any write. A value is checked by its
facet before any write: a word where a number goes, a number outside the facet's range, or a choice the facet
lacks is `refused` by `givenOf` with its words, and the act does not land (an act's writes are not a form's, so
nothing later would refuse them). A given is not kept: it
is the press's, read once.

**Computing, and making a record (revision 45).** An act that changes a quantity leaves a record of the change:
how many, why, and what caused it. That needs four things, each general. A **sum** adds or takes one number from
another wherever a value is written. A **make** is a record the act makes when it lands, under a `when` or not.
A `when` says `!=` and joins comparisons with `and`. And a `then` may write on the **record in hand**, so a write
made only where a condition holds (a counter raised when something was made) is the act's own:

```crubal
act: count /2026-11-16
  utility: inventory
  on: unit
  context: container
  given:
    count as qty "How many are there?" from record.qty
  make:
    moved -> movement when given.count != record.qty
      movedUnit -> link record
      movedQty -> given.count - record.qty
      movedReason -> counted
      movedCause -> link container
      movedAt -> now
  set:
    qty -> given.count
  then:
    when given.count != record.qty set record.movedCount = record.movedCount + 1
```

In a sum, a reference that holds nothing reads as 0 (a counter never yet raised), and one that holds what is no
number stops the act before any write, with the reason; the result is written as a number. In a `when`, as
before, a term that reads no number holds nowhere. Every source of a make and every term of its `when` reads the
record in hand as it stood before the act's writes. `actWrites` answers the records to make (`makes`: name, kind
and values, in the order written) beside the writes; the host MUST make them in the act's own entry, so an act
refused makes nothing, and MUST give each an id that is the same however often it runs the entry. A made
record is not yet something the act's other lines may name (a link to it is a later revision's).

**Standing, and the acts that follow (revision 47).** Two things an act's writes could not say. A record's
**standing**: a then may `archive` or `restore` the record in hand or the records a find answered, so "the last
one sold archives the unit" and "some found brings it back" are the act's own. `actWrites` answers them as
`stands` (id, `archived` or `active`, the reason when one is said); the host MUST write them in the act's own
entry, through the lifecycle's own archive and restore (chapter 8); archiving what is archived, or restoring
what stands, writes nothing. And **the acts that follow**: an act's `also:` names acts to run once it has
landed, so a count that finds a quarantined unit also runs the act that marks it found, whichever utility
provides that. `actWrites` answers them as `also` (utility when named, act, the record's id), in the order
written; the host runs each as the same person, **after** this act's entry, each by its own guards and in its
own entry. One that is refused is said and undoes nothing; an act run this way runs its own `also`, and the
host MUST stop a chain that returns to an act and record it has already run.

**The acts run first (revision 49).** An act may say the acts that run **before** it lands, under `first:`,
each line as an also's: `[<utility>/]<act> on record|<found> [with …] [when …]`. `firstOf` answers them, each
on its record. The host MUST run them in the order written, each as its own act with its own guard; where one
refuses, this act stops with that reason and writes nothing, and what the earlier ones wrote stands (they are
acts of their own, not one entry with this one). The host MUST then read the act's finds again before it
lands, so a record a first act changed is read as it now stands. A line of `first` or `also` may give the act
it runs what that act is given: `with <given> = <value>[, …]`, a literal or a reference read as this act stood
(a found record's own, where the line runs on it). An act given nothing it asks for is refused as any act is.
In the JSON form an act carries `"first": [{"utility", "act", "on", "with": [{"name", "value"}], "when"}]`,
and an also the same `with`.

**A link to what the act makes, and amounts (revision 48).** A make's name may stand where a link's target
does, `link <make>`, in a set, a then's value or another make's set: so the record in hand, a record found or
a second record made can point at the one just made (the two sides of a split each naming the other's
movement). The engine cannot know the id, which is the host's: `actWrites` carries such a link as
`{"$made": "<name>"}` in the values it answers, and the host MUST write the made record's link in its place,
in the act's own entry. Where the make was not made (its `when` did not hold) the write is left out. And a
sum or a `when` reads **amounts** as they are written (1.4): money (`{"$money", "currency"}`) and quantities
(`{"$qty", "unit"}`) beside plain numbers. A sum keeps what its sides are of and the decimal places of the
longer; a plain number beside money or a quantity takes its currency or unit; two currencies or two units are
not summed, and the act stops before any write with the reason. A `when` over two currencies or two units
holds nowhere.

**A closed set (revision 42).** A set of records fixed when the work starts, with a finish that judges the
rest, is three acts on the thing that holds the set and needs no word of its own. The start takes a mark on
it (taken once, so one set is open on a thing at a time) and writes a state on every record it reaches; the
work between is any act on those records; the finish `needs` the mark, gives it back, and writes its
judgement on the records its find still answers in the first state; a cancel `needs` the mark, gives it back
and clears the state. Two things serve it. An act's **`needs`** refuses an act on a record that is not where
the act expects it, with the act's own words. And a then's condition that reads a found record **the then
writes on** (`when inside.qty <= 0 set inside.state = none`) is read on each of those records, and the write
made on those where it holds; its send goes once, when it held on any. A condition that reads nothing the
then writes on is read once, as before; a term that reads no number holds nowhere.
A flow says it is one with `closed:` (12.11).

**A mark is taken once (revision 34).** A facet a `marked` filter names (12.3) is a mark, and holds one value.
An act whose `set` or `then` would write a mark on a record that already holds a real value for it stops
before any write, with the reason; the host hands the engine the marks in force, and MUST land an act inside
the entry's own transaction (8.5) so that of two acts arriving together exactly one lands. This is the whole
of a claim: two people pressing one press on one record have one winner. Clearing a mark (`none`) is an
ordinary set by an act that says so, after which it may be taken again.

**A share (revision 35).** Where an act `takes: share` and the count given is fewer than the record's quantity,
the record is split before the act lands: a new record of the same level, under the same parent, carrying every
value of the first (its marks and its links among them) with the count taken as its quantity, and the first kept
with the rest. The act then lands on the new record. The engine answers the two counts (`shareOf`); the host MUST
write the split and the act's writes in **one entry**, so an act refused leaves the record whole. All of the
quantity is the plain act on the record, with no split; none, more than it holds, or a count that is no whole
number is refused with the reason. A record with no value for its quantity is one thing, taken whole.

## 15.3 Well-formed acts

A package MUST be refused at publish when an act names a utility it doesn't declare or one that neither lists it
among its acts nor lists the act it `replaces`; replaces itself; is `on` no level; names a context that is no kind;
routes over no compound facet, by a column the compound lacks, or over a link facet the level lacks; finds, counts
or mints a kind the package lacks; counts under a name a find, route or count already bears; picks, orders by, sets, mints or reads a facet the package lacks (a route's
column the compound's); names a find, route, count or context it did not declare (a then's link and its references among them, revision 39); sets one facet twice; finds one name
twice; (revision 44) is given one name twice, is given a value as a facet the package lacks, opens a given from what is not the record's or a context record's, reads `given.<name>` it was not given, or names a find `given`; (revision 45) makes a kind the package lacks, makes under a name a find, route, count or make already bears (or `given` or `record`), makes and sets one facet twice, makes and sets nothing, or names a find `record`; (revision 47) archives or restores what is neither the record in hand nor a find, runs an act also on what is neither, also runs an act that a utility the package declares does not list, or also runs itself on the record in hand; (revision 48: a link's target may be a make's name) mints a find that takes `all`; lands when the send reports and sends nothing; takes anything but `share`, or takes a share on a level whose kind declares no quantity for it (revision 35); or, revision 31, tells a kind the
package lacks, tells as an aspect no kind declares under `follow:`, tells with no set lines, or tells and sets one
facet twice. In force (11.4, at install) the aspect is the exception: a telling whose aspect no kind in force
declares is **inert**, never a refusal, since nobody can follow by an aspect nobody declares and the kind that
declares it may land on a later install; the other checks refuse as the publish would have. As a flow's (12.11), a
package that extends others may name their utilities, kinds and facets: what the file-local check cannot see it
leaves to the check of the packages in force together (11.4, at install), which refuses as the publish would have.

## 15.4 The JSON form

An act is `{"act", "version", "utility", "replaces", "label", "describe", "on", "takes", "context": [...], "needs": [{"facet", "lacks": true, "words"}] (revision 42), "given": [{"name", "facet", "words", "from": reference, "default"}] (revision 44), "route": {"name",
"rows": reference, "by", "over": [reference…], "keep": {"column", "kind", "where": [pick…]}}, "finds": [{"name",
"take", "kind", "where": [{"facet", "value": {"literal"} | {"caller": true} | {"self": true} (revision 39: the record in hand) | reference}], "order": {"facet", "dir"}, "mint": {"kind",
"sets": [set…]}}], "counts": [{"name", "kind", "where": [pick…]}], "sets": [{"facet", "source": {"literal"} | {"link"} | {"now": true} | {"caller": true} | {"none": true} | {"next": {"prefix":
reference | {"literal"}, "in": {"kind", "facet"}, "suffix": reference}} | {"owner": true} | {"run": true} | (revision 46) {"person": true} | (revision 45) {"sum": {"left", "op": "+" | "-", "right"}} (each side `{"number"}` or a reference) | reference}], "thens": [{"when": {"left", "op", "right"} (a term `{"ref", "plus"} | {"count", "plus"} | {"number"}`),
"sets": [{"found", "facet", "value": {"literal"} | {"now": true} | (revision 39) {"none": true} | {"link"} | {"caller": true} | reference}], "send": {"verb", "words"}}] (`when` absent from revision 39 where the then has no condition; revision 45: a `when` may carry `"and": [{"left", "op", "right"}…]`, its op may be `"!="`, a then's value may be `{"sum"}` or (revision 46) `{"person": true}`, and a then's `found` may be `"record"`, the record in hand), (revision 45) "makes": [{"name", "kind", "when", "sets": [set…]}], (revision 47: a comparison may be `{"has": reference, "lacks": true}`; a then may carry `"stand": {"to": "archived" | "active", "on", "reason"}` with empty `sets`) "also": [{"utility", "act", "on", "when"}], (revision 48: a link set's `link` may be a make's name) "send": {"verb",
"words"}, "lands", "tells": {"kind", "aspect", "sets": [set…]}}` under `acts` (`tells` from revision 31; a link set's `link` may be `record`); a reference is `{"record"} | {"context"} | {"context", "facet"} | {"found"} | {"found",
"facet"} | {"route", "column"} | (revision 44) {"given"}`; a pick's facet may be `"<link>.<facet>"`. An act holds no value on any record:
retiring one is a safe change (10.5). A reader that doesn't know the act carries it unchanged (13.5).
