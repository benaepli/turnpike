// Mencius Protocol P liveness bug -- slide deck.
//
// A crashed revoker permanently orphans a slot in bare Protocol P. Companion
// to liveness_P.md.
//
// Build:
//   typst compile bin/spur/mencius/liveness_P.typ
// First compile fetches packages from Typst Universe (needs network unless
// already cached). Toolchain pinned for Typst 0.13.x:
//   touying 0.7.2, cetz 0.3.4
// (cetz 0.5+ requires Typst 0.14+.) Incremental reveals in the space-time
// diagrams use callback-style slides (`repeat:` + `self.subslide`) that draw
// one stage per subslide; the lifelines and an invisible bounding rect are
// always drawn so the canvas does not jump between subslides. Text slides use
// `#pause`.

#import "@preview/touying:0.7.2": *
#import themes.simple: *
#import "@preview/cetz:0.3.4"

// subslide-preamble: none -- otherwise the simple theme prints each `==`
// heading both in its auto preamble and in the body (duplicate title).
#show: simple-theme.with(aspect-ratio: "16-9", subslide-preamble: none)

// Smaller than the theme default (25pt) so dense slides do not overflow.
#set text(size: 20pt)

// ── Palette ────────────────────────────────────────────────────────────────
#let cP1 = rgb("#1f6feb")   // Phase 1: PREPARE / ACK
#let cP2 = rgb("#1a7f37")   // Phase 2: PROPOSE / ACCEPT
#let cLrn = rgb("#8250df")  // LEARN
#let cBad = rgb("#cf222e")  // reject / crash
#let cAcc = rgb("#ffd86b")  // accent for the dark focus slide
#let ocolors = (rgb("#1f6feb"), rgb("#bf8700"), rgb("#1a7f37"))
#let ocolor(i) = ocolors.at(calc.rem(i, 3))

// ── Space-time diagram helpers (CeTZ) ────────────────────────────────────────
#let P0 = 0.0
#let P1 = 4.3
#let P2 = 8.6

#let lifelines(depth) = {
  import cetz.draw: *
  for it in ((P0, "p0"), (P1, "p1"), (P2, "p2")) {
    line((it.at(0), 0.55), (it.at(0), -depth), stroke: (paint: luma(170), thickness: 0.8pt))
    content((it.at(0), 0.95), text(weight: "bold")[#it.at(1)])
  }
}

#let lifelines2(depth, ax, an, bx, bn) = {
  import cetz.draw: *
  for it in ((ax, an), (bx, bn)) {
    line((it.at(0), 0.55), (it.at(0), -depth), stroke: (paint: luma(170), thickness: 0.8pt))
    content((it.at(0), 0.95), text(weight: "bold", size: 0.62em)[#it.at(1)])
  }
}

#let msg(a, b, label, clr: black, dashed: false, t: 0.5, dy: 0.2) = {
  import cetz.draw: *
  line(a, b,
    stroke: (paint: clr, thickness: 1.1pt, dash: if dashed { "dashed" } else { none }),
    mark: (end: ">", fill: clr, scale: 0.8))
  let lx = a.at(0) + t * (b.at(0) - a.at(0))
  let ly = a.at(1) + t * (b.at(1) - a.at(1))
  content((lx, ly + dy), text(fill: clr, size: 0.58em, weight: "medium")[#label])
}

// Note: call cetz.draw.content fully-qualified -- `import cetz.draw: *` would
// pull in cetz's own `anchor` function and shadow the `anchor` parameter.
#let note(p, body, clr: black, anchor: "center", size: 0.6em) = {
  cetz.draw.content(p, text(fill: clr, size: size)[#body], anchor: anchor)
}

#let xmark(p, clr: cBad) = {
  import cetz.draw: *
  let s = 0.14
  line((p.at(0) - s, p.at(1) + s), (p.at(0) + s, p.at(1) - s), stroke: (paint: clr, thickness: 1.7pt))
  line((p.at(0) - s, p.at(1) - s), (p.at(0) + s, p.at(1) + s), stroke: (paint: clr, thickness: 1.7pt))
}

// ─────────────────────────────────────────────────────────────────────────────
// Title
// ─────────────────────────────────────────────────────────────────────────────

#title-slide[
  = A liveness bug in Mencius Protocol P
  #v(0.4em)
  How one crashed revoker can wedge the whole log
  #v(0.8em)
  #text(size: 0.8em, fill: luma(100))[Mencius (Mao, Junqueira, Marzullo, OSDI 2008) -- Protocol P, Appendices A + B]
]

// ─────────────────────────────────────────────────────────────────────────────
// Refresher
// ─────────────────────────────────────────────────────────────────────────────

#slide[
  == Refresher 1/4 -- the replicated log

  Mencius replicates a *log*: an array of slots, each decided by one
  independent consensus instance. Slots are pre-assigned round-robin,
  $"owner"(i) = i mod n$ (here $n = 3$):

  #v(0.6em)
  #align(center)[
    #grid(columns: (auto,) * 6, gutter: 8pt,
      ..range(6).map(i => box(
        width: 1.7cm, height: 1.15cm, inset: 5pt, radius: 4pt,
        fill: ocolor(i).lighten(80%), stroke: ocolor(i) + 0.7pt,
      )[
        #align(center + horizon)[
          #text(size: 0.72em, weight: "bold")[slot #i] \
          #text(size: 0.62em, fill: ocolor(i).darken(15%))[owner p#calc.rem(i, 3)]
        ]
      ])
    )
  ]
  #v(0.6em)

  - Commit is *strictly in log order*: slot $i$ is applied only after every
    slot $< i$ is learned. One un-learned slot blocks everything behind it.
  - Today's focus: *slot 2*, owned by *p2*.
]

#slide(repeat: 5, self => {
  let i = self.subslide
  [
    == Refresher 2/4 -- Coordinated Paxos messages

    Each slot runs one Paxos instance over two phases.

    #v(0.3em)
    #grid(columns: (1.1fr, 1fr), column-gutter: 1.2em, align: horizon,
      [
        #text(size: 0.78em)[
          #table(columns: (auto, auto), inset: 5pt, align: left,
            stroke: 0.5pt + luma(200),
            table.header([*message*], [*role*]),
            text(fill: cP1)[`PREPARE(b)`], [Phase 1a: ask to lead ballot b],
            text(fill: cP1)[`ACK(b,ab,av)`], [Phase 1b: promise + last accept],
            text(fill: cP2)[`PROPOSE(b,v)`], [Phase 2a: accept v at b],
            text(fill: cP2)[`ACCEPT(b,v)`], [Phase 2b: accepted (b, v)],
            text(fill: cLrn)[`LEARN(v)`], [quorum accepted: v is chosen],
          )
        ]
      ],
      [
        #cetz.canvas({
          import cetz.draw: *
          rect((-0.9, 0.95), (4.5, -4.45), stroke: none)
          lifelines2(4.6, 0, "proposer", 3.6, "acceptors")
          if i >= 1 { msg((0, -0.4), (3.6, -0.9), "PREPARE(b)", clr: cP1, dy: 0.18) }
          if i >= 2 { msg((3.6, -1.2), (0, -1.7), "ACK(b,a,v)", clr: cP1, dy: 0.18) }
          if i >= 3 { msg((0, -2.0), (3.6, -2.5), "PROPOSE(b,v)", clr: cP2, dy: 0.18) }
          if i >= 4 { msg((3.6, -2.8), (0, -3.3), "ACCEPT(b,v)", clr: cP2, dy: 0.18) }
          if i >= 5 { msg((0, -3.6), (3.6, -4.1), "LEARN(v)", clr: cLrn, dy: 0.18) }
        })
      ]
    )
    #v(0.2em)
    #text(size: 0.78em, fill: luma(90))[A value is *chosen* once a quorum
      accepts it at one ballot; thereafter it cannot change.]
  ]
})

#slide[
  == Refresher 3/4 -- two ways a slot gets a value

  *Fast path (the owner).* Every acceptor starts each slot already promised at
  ballot 0, and the slot's owner is the implicit leader of ballot 0. So the
  owner skips Phase 1 and just sends `PROPOSE(0, v)` -- a *SUGGEST*
  (`PROPOSE(0, no-op)` is a *SKIP*).

  #pause
  #v(0.3em)
  *Revoke (anyone else).* If a server *suspects* the owner failed, it takes the
  slot over: a full Phase 1 + Phase 2 at a *strictly higher* ballot.

  #pause
  #v(0.3em)
  #box(inset: 8pt, radius: 4pt, fill: cBad.lighten(88%), stroke: cBad + 0.6pt)[
    *Key asymmetry.* The owner only ever uses ballot 0 and *never raises its
    own ballot*. The only path to a higher ballot is someone else's
    suspicion-driven Revoke.
  ]
]

#slide[
  == Refresher 4/4 -- the two safety facts

  #v(0.5em)
  #text(weight: "bold")[1.] An acceptor accepts `PROPOSE(b, v)` *only if* it has
  not promised a higher ballot and not already accepted at $>= b$:
  #align(center)[#text(fill: cP2)[$"prepared_ballot" <= b   "and"   "accepted_ballot" < b$]]

  #pause
  #v(0.5em)
  #text(weight: "bold")[2.] A value is *chosen* exactly when a *quorum* has
  accepted it at the same ballot. With $n = 3$, a quorum is $2$.

  #pause
  #v(0.7em)
  #text(fill: luma(90))[Consequence we will use: if a revoker raises
    `prepared_ballot` to 1 on a server, that server will *reject* the owner's
    later ballot-0 SUGGEST -- silently, since Coordinated Paxos has no NACK.]
]

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

#slide[
  == The setup

  #grid(columns: (1fr, 1fr), column-gutter: 1em,
    [
      - Three servers *p0, p1, p2*; quorum $= 2$.
      - Slot 2 is owned by *p2*.
      - Slots 0--1 already committed everywhere, so all sit at
        `expected = 2`.
      - *p0 and p2 are correct and stay alive.*
      - *p1 is faulty -- it will crash.*
    ],
    [
      #align(center)[
        #box(inset: 9pt, radius: 5pt, stroke: luma(180) + 0.6pt)[
          per-slot state \
          #text(size: 0.85em)[`{prepared_ballot, accepted_ballot,` \
          `  accepted_value, learned}`] \
          #v(0.3em)
          starts at $\{0, -1, bot, bot\}$
        ]
      ]
    ]
  )
  #v(0.5em)
  #text(size: 0.85em, fill: luma(90))[Ballot 0 is the owner's reserved ballot; a
    revoke uses any strictly higher ballot the revoker owns.]
]

// ─────────────────────────────────────────────────────────────────────────────
// The trace
// ─────────────────────────────────────────────────────────────────────────────

#slide(repeat: 4, self => {
  let i = self.subslide
  [
    == The trace -- a crashed revoker orphans slot 2

    #cetz.canvas({
      import cetz.draw: *
      rect((-2.6, 1.2), (11.2, -6.0), stroke: none) // lock canvas bounds
      lifelines(5.6)

      // Stage 1: p1 (falsely) suspects p2, revokes slot 2, then crashes.
      if i >= 1 {
        note((P1, -0.3), text(fill: cP1, weight: "medium")[suspects p2, Revoke(2)], anchor: "south", size: 0.55em)
        msg((P1, -0.75), (P0, -2.4), "PREPARE(1)", clr: cP1, t: 0.6)
        msg((P1, -0.75), (P2, -2.8), "PREPARE(1)", clr: cP1, t: 0.78)
        xmark((P1, -1.2))
        note((P1 - 0.22, -1.2), [crash], clr: cBad, anchor: "east", size: 0.55em)
      }

      // Stage 2: p2 suggests v and accepts its own copy at ballot 0 (pb still 0).
      if i >= 2 {
        note((P2 - 0.18, -0.85), [accept $v$ (b0)], clr: cP2, anchor: "east", size: 0.55em)
        msg((P2, -1.0), (P0, -3.7), "PROPOSE(0, v)", clr: cP2, t: 0.4)
      }

      // Stage 3: PREPARE reached p0 first, so p0 rejects the SUGGEST.
      if i >= 3 {
        note((P0 + 0.18, -2.4), [pb := 1], clr: cP1, anchor: "west", size: 0.55em)
        note((P2 - 0.18, -2.8), [pb := 1], clr: cP1, anchor: "east", size: 0.55em)
        note((P0 + 0.18, -3.75), [reject: $1 lt.eq 0$], clr: cBad, anchor: "west", size: 0.55em)
      }

      // Stage 4: only one acceptor holds v.
      if i >= 4 {
        line((-1.4, -4.7), (10.0, -4.7), stroke: (paint: luma(205), thickness: 0.6pt))
        note((P1, -5.2), text(weight: "bold")[v accepted only by p2 = 1 of 2 needed, never chosen, no LEARN], clr: cBad, anchor: "center", size: 0.58em)
      }
    })

    #if i >= 4 [
      #text(size: 0.74em, fill: luma(110))[Counterfactual: had `PROPOSE(0,v)`
        reached p0 *before* `PREPARE(1)`, p0 would accept, p0 and p2 form a
        quorum, v is chosen. The bug needs PREPARE-before-SUGGEST at p0.]
    ]
  ]
})

#slide[
  == After the dust settles

  #align(center)[
    #table(columns: 5, inset: 8pt, align: center + horizon,
      stroke: 0.5pt + luma(200),
      table.header([*slot 2*], [pb], [ab], [av], [learned]),
      [*p0*], [1], [$-1$], [$bot$], [$bot$],
      [*p1*], table.cell(colspan: 4, fill: cBad.lighten(88%))[crashed],
      [*p2*], [1], [0], [$v$], [$bot$],
    )
  ]
  #v(0.6em)
  - `v` is accepted by *one* server (p2) -- below quorum, so *never chosen*.
  - No `LEARN(v)` is ever broadcast.
  - p0 and p2 are both promised at ballot 1, so the owner's ballot-0 fast path
    is *dead* for slot 2.
]

// ─────────────────────────────────────────────────────────────────────────────
// Why it is stuck
// ─────────────────────────────────────────────────────────────────────────────

#slide[
  == Who could ever resolve slot 2?

  Resolution needs either (a) a value chosen, or (b) a completing Revoke at a
  ballot $> 1$.

  #v(0.4em)
  #pause
  - #text(fill: cBad)[*Chosen at ballot 0?*] No -- p0 rejects further
    `PROPOSE(0, ...)`, and the owner p2 never escalates above ballot 0.
  #pause
  - #text(fill: cBad)[*p2 revokes its own slot?*] No -- `OnSuspect` only revokes
    *other* servers' slots; a server never revokes itself.
  #pause
  - #text(fill: cBad)[*p0 revokes slot 2?*] Only if it suspects p2. But p2 is
    *correct*, so an eventually-accurate detector (#sym.diamond.stroked P)
    eventually stops suspecting it.
  #pause
  - #text(fill: cBad)[*The crashed p1?*] It never ran Phase 2, and it is dead.
  #pause
  - #text(fill: cBad)[*Suspecting the dead p1?*] Correct -- but `OnSuspect(p1)`
    revokes *p1's* slots (1, 4, 7, ...), never slot 2.

  #pause
  #v(0.3em)
  #align(center)[#text(weight: "bold", fill: cBad)[Slot 2 is permanently
    orphaned -- and every later slot wedges behind it.]]
]

#focus-slide[
  The owner is pinned to ballot 0 and never escalates; the only escalation is
  suspicion of the owner.

  #v(0.5em)
  #text(size: 0.8em)[So a #text(fill: cAcc, weight: "bold")[correct] owner can
    be locked out by a #text(fill: cAcc, weight: "bold")[crashed] revoker -- and
    recovery would require permanently, falsely suspecting a correct server.
    Multi-Paxos avoids this because a leader just keeps climbing ballots.]
]

#slide[
  == A note on reproducing it

  This stall is *not* surfaced by the current Spur simulator:

  #v(0.3em)
  - `monitor_suspicions` in `Mencius_P.spur` suspects *every* peer on *every*
    tick, so p0 eventually revokes slot 2 and it self-heals -- masking the bug
    precisely by doing the degenerate thing the bug depends on not happening.
  - Porcupine checks linearizability (*safety*), not progress.

  #v(0.4em)
  Surfacing it would need (out of scope here):
  - an *eventually-accurate* failure-detector model (stops suspecting correct
    nodes), and
  - a *no-progress / liveness* check.

  #v(0.4em)
  #text(size: 0.85em, fill: luma(100))[Full write-up: `liveness_P.md`.]
]
