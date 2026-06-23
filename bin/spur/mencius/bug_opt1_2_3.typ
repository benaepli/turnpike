// Mencius Optimization 1 x Optimization 3 Agreement bug -- slide deck.
//
// A false suspicion + a concurrent block-revoke makes the skip-inference
// fabricate a no-op over a slot a quorum already committed, so correct servers
// diverge on one slot. Companion to bug_opt1_2_3.md.
//
// Build:
//   typst compile bin/spur/mencius/bug_opt1_2_3.typ
// First compile fetches packages from Typst Universe (needs network unless
// already cached). Toolchain pinned for Typst 0.13.x:
//   touying 0.7.2, cetz 0.3.4
// (cetz 0.5+ requires Typst 0.14+.) Per-phase space-time diagrams use
// callback-style slides (`repeat:` + `self.subslide`) that draw one stage per
// subslide; the lifelines and an invisible bounding rect are always drawn so
// the canvas does not jump between subslides. An evolving state ledger tracks
// slot-2 state + p1's est_index[p2] across phases. Text slides use `#pause`.

#import "@preview/touying:0.7.2": *
#import themes.simple: *
#import "@preview/cetz:0.3.4"

// subslide-preamble: none -- otherwise the simple theme prints each `==`
// heading both in its auto preamble and in the body (duplicate title).
#show: simple-theme.with(aspect-ratio: "16-9", subslide-preamble: none)

// Smaller than the theme default (25pt) so dense slides do not overflow.
#set text(size: 20pt)

// ── Palette ────────────────────────────────────────────────────────────────
#let cP1 = rgb("#1f6feb")   // PREPARE / ballot 1 (revoke)
#let cP2 = rgb("#1a7f37")   // PROPOSE / ACCEPT and the real value v
#let cLrn = rgb("#8250df")  // LEARN
#let cBad = rgb("#cf222e")  // no-op / reject / fabrication
#let cAcc = rgb("#ffd86b")  // est_index pointer / focus-slide accent
#let cHi = cAcc.lighten(40%) // ledger changed-cell highlight
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
    content((it.at(0), 0.95), text(weight: "bold", size: 0.7em)[#it.at(1)])
  }
}

#let msg(a, b, label, clr: black, dashed: false, t: 0.5, dy: 0.2) = {
  import cetz.draw: *
  line(a, b,
    stroke: (paint: clr, thickness: 1.1pt, dash: if dashed { "dashed" } else { none }),
    mark: (end: ">", fill: clr, scale: 0.8))
  let lx = a.at(0) + t * (b.at(0) - a.at(0))
  let ly = a.at(1) + t * (b.at(1) - a.at(1))
  content((lx, ly + dy), text(fill: clr, size: 0.55em, weight: "medium")[#label])
}

// Note: call cetz.draw.content fully-qualified -- `import cetz.draw: *` would
// pull in cetz's own `anchor` function and shadow the `anchor` parameter.
#let note(p, body, clr: black, anchor: "center", size: 0.58em) = {
  cetz.draw.content(p, text(fill: clr, size: size)[#body], anchor: anchor)
}

#let xmark(p, clr: cBad) = {
  import cetz.draw: *
  let s = 0.14
  line((p.at(0) - s, p.at(1) + s), (p.at(0) + s, p.at(1) - s), stroke: (paint: clr, thickness: 1.7pt))
  line((p.at(0) - s, p.at(1) - s), (p.at(0) + s, p.at(1) + s), stroke: (paint: clr, thickness: 1.7pt))
}

// A local (non-message) computation, drawn as a dashed callout at a lifeline.
#let computebox(p, body, anchor: "west") = {
  cetz.draw.content(
    p,
    box(inset: 5pt, radius: 3pt, fill: cBad.lighten(92%),
        stroke: (paint: cBad, dash: "dashed", thickness: 0.7pt))[
      #text(size: 0.5em, fill: cBad.darken(8%))[#body]
    ],
    anchor: anchor,
  )
}

// ── Evolving state ledger (slot 2 + p1's est_index[p2]) ──────────────────────
#let lc(v, hot) = if hot { table.cell(fill: cHi)[#v] } else { v }

#let ledger(p0, p1, p2, est, hi: ()) = {
  let H(k) = hi.contains(k)
  align(center)[
    #text(size: 0.9em)[
      #table(columns: 5, inset: 6pt, align: center + horizon,
        stroke: 0.5pt + luma(200),
        table.header([*slot 2*], [pb], [ab], [av], [learned]),
        [*p0*], lc(p0.at(0), H("p0pb")), lc(p0.at(1), H("p0ab")), lc(p0.at(2), H("p0av")), lc(p0.at(3), H("p0lr")),
        [*p1*], lc(p1.at(0), H("p1pb")), lc(p1.at(1), H("p1ab")), lc(p1.at(2), H("p1av")), lc(p1.at(3), H("p1lr")),
        [*p2*], lc(p2.at(0), H("p2pb")), lc(p2.at(1), H("p2ab")), lc(p2.at(2), H("p2av")), lc(p2.at(3), H("p2lr")),
      )
    ]
    #v(0.3em)
    #text(size: 0.8em)[p1's `est_index[p2]` =
      #if H("est") { text(fill: cBad, weight: "bold")[#est] } else { est }]
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
// Title
// ─────────────────────────────────────────────────────────────────────────────

#title-slide[
  = An Agreement bug in Mencius (Optimizations 1 + 3)
  #v(0.4em)
  How a false suspicion makes correct servers commit different values for one slot
  #v(0.8em)
  #text(size: 0.8em, fill: luma(100))[Mencius (Mao, Junqueira, Marzullo, OSDI 2008) -- full algorithm, Appendix C]
]

// ─────────────────────────────────────────────────────────────────────────────
// Refresher
// ─────────────────────────────────────────────────────────────────────────────

#slide[
  == Refresher 1/3 -- the replicated log

  Mencius replicates a *log* of slots, each decided by one Paxos instance.
  Slots are pre-assigned round-robin to a *coordinator*,
  $"owner"(i) = i mod n$ (here $n = 3$):

  #v(0.5em)
  #align(center)[
    #grid(columns: (auto,) * 6, gutter: 8pt,
      ..range(6).map(i => {
        let revoked = (i == 2 or i == 5)
        let door = (i == 4)
        box(width: 1.7cm, height: 1.1cm, inset: 5pt, radius: 4pt,
          fill: ocolor(i).lighten(80%),
          stroke: if door { cAcc.darken(25%) + 1.8pt }
                  else if revoked { ocolor(i) + 1.6pt }
                  else { ocolor(i) + 0.7pt })[
          #align(center + horizon)[
            #text(size: 0.72em, weight: "bold")[slot #i] \
            #text(size: 0.6em, fill: ocolor(i).darken(15%))[owner p#calc.rem(i, 3)]
          ]
        ]
      })
    )
  ]
  #v(0.5em)

  - *p2* owns slots *2, 5, 8, ...* -- p1 will revoke this whole *block*.
  - *p1* owns slot *4* -- the one door the bug walks through.
  - Commit is strictly in log order; the violation will be on *slot 2*.
]

#slide(repeat: 5, self => {
  let i = self.subslide
  [
    == Refresher 2/3 -- Coordinated Paxos messages

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
          lifelines2(4.6, 0, "owner", 3.6, "acceptors")
          if i >= 1 { msg((0, -0.4), (3.6, -0.9), "PREPARE(b)", clr: cP1, dy: 0.18) }
          if i >= 2 { msg((3.6, -1.2), (0, -1.7), "ACK(b,a,v)", clr: cP1, dy: 0.18) }
          if i >= 3 { msg((0, -2.0), (3.6, -2.5), "PROPOSE(b,v)", clr: cP2, dy: 0.18) }
          if i >= 4 { msg((3.6, -2.8), (0, -3.3), "ACCEPT(b,v)", clr: cP2, dy: 0.18) }
          if i >= 5 { msg((0, -3.6), (3.6, -4.1), "LEARN(v)", clr: cLrn, dy: 0.18) }
        })
      ]
    )
    #v(0.2em)
    #text(size: 0.78em, fill: luma(90))[*SUGGEST* = `PROPOSE(0, v)` (real value);
      *SKIP* = `PROPOSE(0, no-op)` (empty). The owner uses ballot 0 with no Phase 1.]
  ]
})

#slide[
  == Refresher 3/3 -- accept test, quorum, and revoke

  #text(weight: "bold")[Accept.] A server accepts `PROPOSE(b, v)` *only if*
  #align(center)[#text(fill: cP2)[$"prepared_ballot" <= b   "and"   "accepted_ballot" < b$]]

  #pause
  #v(0.3em)
  #text(weight: "bold")[Chosen.] A value is locked forever once a *quorum*
  (2 of 3) accepts it at one ballot. The quorum holder broadcasts `LEARN(v)`.

  #pause
  #v(0.3em)
  #text(weight: "bold")[Revoke.] A server that *suspects* the coordinator grabs
  a *higher* ballot and runs `PREPARE(b)`, bumping recipients'
  `prepared_ballot` to b.

  #pause
  #v(0.3em)
  #box(inset: 8pt, radius: 4pt, fill: cP1.lighten(88%), stroke: cP1 + 0.6pt)[
    *This is the problem.* After a revoke raises `prepared_ballot` to 1, the
    owner's later ballot-0 SUGGEST fails the test ($1 <= 0$ is false) and is
    *silently rejected* -- Coordinated Paxos has no NACK.
  ]
]

// ─────────────────────────────────────────────────────────────────────────────
// The optimization that causes the bug
// ─────────────────────────────────────────────────────────────────────────────

#slide[
  == Optimization 1 -- infer skips instead of sending them

  Broadcasting an explicit SKIP for every empty slot is wasteful. So each
  server keeps `est_index[q]` = "the lowest `q`-owned slot I have not yet
  accounted for", and *infers* skips:

  #pause
  #v(0.3em)
  #box(inset: 8pt, radius: 4pt, fill: luma(245), stroke: luma(180) + 0.6pt)[
    When I process a message from `q` about its slot `i`, every `q`-owned slot
    below `i` that I have not learned, I conclude `q` *skipped* -- so I write
    `no-op` into those slots myself, and advance `est_index[q]`.
  ]

  #pause
  #v(0.3em)
  *Justification (FIFO, Lemmas 5/6).* By the time `q`'s message about slot `i`
  reaches me, I have already received everything `q` sent earlier. If `q` had
  suggested a real value to an earlier slot `j`, I would know it. I do not --
  therefore `q` skipped `j`.
]

#slide[
  == The hidden assumption -- and how revoke breaks it

  #box(inset: 8pt, radius: 4pt, fill: cAcc.lighten(55%), stroke: cAcc.darken(20%) + 0.7pt)[
    The inference equates *"I never processed a real suggestion from q for
    slot j"* with *"q never sent one."*
  ]

  #pause
  #v(0.4em)
  That holds in the base protocol. *Revocation breaks it:* a revoke can make me
  *receive* `q`'s real suggestion and then *throw it away* on the ballot test --
  recording *nothing*.

  #pause
  #v(0.4em)
  #grid(columns: (1fr, auto), column-gutter: 1em, align: horizon,
    [
      The suggestion was sent and received, yet left *no trace*. The inference
      then fabricates a `no-op` over a slot the coordinator genuinely *used*.
    ],
    [
      #cetz.canvas({
        import cetz.draw: *
        rect((-0.6, 0.95), (4.6, -2.7), stroke: none)
        lifelines2(2.4, 0, "p2", 4.0, "p1 (pb=1)")
        msg((0, -0.5), (4.0, -1.4), "PROPOSE(0, v)", clr: cP2, dy: 0.16, t: 0.5)
        xmark((4.0, -1.4))
        note((4.0 - 0.2, -1.75), [reject: $1 lt.eq 0$ -- no trace], clr: cBad, anchor: "east", size: 0.5em)
      })
    ]
  )
]

#slide[
  == Optimization 3 -- why slot 4 is the only door

  `OnSuspect(q)` does not revoke one slot. It revokes a whole *β-window* block
  of `q`-owned slots (paper uses β = 100000; we use 2, window `[2, 5]`):

  #v(0.4em)
  #align(center)[
    #grid(columns: (auto,) * 6, gutter: 8pt,
      ..range(6).map(i => {
        let revoked = (i == 2 or i == 5)
        let door = (i == 4)
        box(width: 1.7cm, height: 1.0cm, inset: 4pt, radius: 4pt,
          fill: if revoked { cP1.lighten(75%) } else if door { cAcc.lighten(55%) } else { luma(245) },
          stroke: if door { cAcc.darken(25%) + 1.6pt }
                  else if revoked { cP1 + 1.4pt } else { luma(190) + 0.7pt })[
          #align(center + horizon)[
            #text(size: 0.66em, weight: "bold")[slot #i] \
            #text(size: 0.56em)[#if revoked [revoked] else if door [p1: open] else [p#calc.rem(i, 3)]]
          ]
        ]
      })
    )
  ]
  #v(0.4em)

  #pause
  - Suspecting p2 revokes *2 and 5* -- a later SUGGEST to slot 5 is rejected
    too, so the bug *cannot* route through slot 5.
  - p1 never revokes its *own* slots. *Slot 4 stays at ballot 0* -- the path
    the trace must take.
]

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

#slide[
  == The setup

  #grid(columns: (1.05fr, 1fr), column-gutter: 1em, align: horizon,
    [
      - Three servers *p0, p1, p2*; quorum $= 2$; FIFO links, *no crashes*.
      - p1 *falsely suspects* p2 (the paper's detector is only *eventually*
        accurate). p2 is *alive and correct*.
      - Slot 2 unlearned everywhere; on p1, `est_index[p2] = 2`, `my_index = 1`.
      - Goal: a *divergence* on slot 2.
    ],
    [
      #ledger(
        ([0], [$-1$], [$bot$], [$bot$]),
        ([0], [$-1$], [$bot$], [$bot$]),
        ([0], [$-1$], [$bot$], [$bot$]),
        [2],
      )
    ]
  )
]

// ─────────────────────────────────────────────────────────────────────────────
// The trace, phase by phase
// ─────────────────────────────────────────────────────────────────────────────

#slide(repeat: 2, self => {
  let i = self.subslide
  [
    == Phase A -- p1 falsely suspects p2 and block-revokes {2, 5}

    #cetz.canvas({
      import cetz.draw: *
      rect((-2.6, 1.2), (11.4, -3.5), stroke: none)
      lifelines(3.0)
      if i >= 1 {
        note((P1, -0.3), text(fill: cP1, weight: "medium")[suspects p2: revoke {2, 5} at ballot 1], anchor: "south", size: 0.56em)
        note((P1, -1.05), text(fill: cP1)[p1 self-promotes: `pb[2]`, `pb[5]` := 1], anchor: "north", size: 0.54em)
      }
      if i >= 2 {
        msg((P1, -1.5), (P0 + 1.4, -2.7), "PREPARE(1)", clr: cP1, dashed: true, t: 0.82)
        msg((P1, -1.5), (P2 - 1.4, -2.7), "PREPARE(1)", clr: cP1, dashed: true, t: 0.82)
        note((P1, -3.05), text(fill: luma(110))[delayed in flight -- not yet applied at p0, p2], anchor: "center", size: 0.52em)
      }
    })

    #if i >= 2 [
      #ledger(
        ([0], [$-1$], [$bot$], [$bot$]),
        ([1], [$-1$], [$bot$], [$bot$]),
        ([0], [$-1$], [$bot$], [$bot$]),
        [2], hi: ("p1pb",),
      )
    ]
  ]
})

#slide(repeat: 3, self => {
  let i = self.subslide
  [
    == Phase B+C -- {p0, p2} choose v at slot 2; p1 rejects

    #cetz.canvas({
      import cetz.draw: *
      rect((-2.6, 1.2), (11.4, -4.7), stroke: none)
      lifelines(4.2)
      // Stage 1: p2 broadcasts SUGGEST and accepts its own copy at ballot 0.
      if i >= 1 {
        note((P2 - 0.18, -0.5), [SUGGEST $v$; accept own (b0)], clr: cP2, anchor: "east", size: 0.54em)
        msg((P2, -0.8), (P0, -1.8), "PROPOSE(0, v)", clr: cP2, t: 0.8)
      }
      // Stage 2: p0 accepts -> quorum {p0, p2} chooses v -> LEARN.
      if i >= 2 {
        msg((P0, -2.1), (P2, -2.9), "ACCEPT(0, v)", clr: cP2, t: 0.5)
        msg((P2, -3.2), (P0, -3.9), "LEARN(v)", clr: cLrn, t: 0.5)
        note((P0 + 0.18, -4.25), text(weight: "medium")[quorum {p0, p2}: $v$ chosen + committed], clr: cP2, anchor: "west", size: 0.54em)
      }
      // Stage 3: p1 received the SUGGEST too, but rejects on the ballot test.
      if i >= 3 {
        xmark((P1, -1.05))
        note((P1 + 0.25, -1.05), [p1 rejects SUGGEST: $1 lt.eq 0$], clr: cBad, anchor: "west", size: 0.54em)
      }
    })

    #if i >= 3 [
      #text(size: 0.74em, fill: luma(110))[p1 records *nothing* -- the committed
        `v` leaves no mark on it, so `est_index[p2]` stays 2 (stale).]
      #ledger(
        ([0], [0], [$v$], [$v$]),
        ([1], [$-1$], [$bot$], [$bot$]),
        ([0], [0], [$v$], [$v$]),
        [2], hi: ("p0av", "p0lr", "p2av", "p2lr", "est"),
      )
    ]
  ]
})

#slide(repeat: 3, self => {
  let i = self.subslide
  [
    == Phase D -- slot 4 triggers a fabricated no-op for slot 2

    #cetz.canvas({
      import cetz.draw: *
      rect((-2.6, 1.2), (11.4, -4.6), stroke: none)
      lifelines(4.0)
      if i >= 1 {
        note((P1, -0.25), text(fill: cP2, weight: "medium")[SUGGEST $v'$ to its own slot 4 (pb=0)], anchor: "south", size: 0.54em)
        msg((P1, -0.7), (P2, -1.7), "PROPOSE(0, v') -- slot 4", clr: cP2, t: 0.55)
      }
      if i >= 2 {
        msg((P2, -1.9), (P1, -2.7), "ACCEPT(0, v') -- slot 4", clr: cP2, t: 0.45)
      }
      if i >= 3 {
        computebox((P1, -3.0), [`ACCEPT(slot 4)` fires the inference: #linebreak() `QSkipSet = {2}` -> `learn(slot 2, no-op)`; #linebreak() `est_index[p2]` -> 5], anchor: "north")
      }
    })

    #if i >= 3 [
      #ledger(
        ([0], [0], [$v$], [$v$]),
        ([1], [$-1$], [$bot$], [no-op]),
        ([0], [0], [$v$], [$v$]),
        [5], hi: ("p1lr", "est"),
      )
    ]
  ]
})

#slide(repeat: 2, self => {
  let i = self.subslide
  [
    == Why the LEARN is legitimately late (FIFO is not broken)

    On the *p2 -> p1* channel, p2 sends `ACCEPT(slot 4)` the moment it gets
    p1's SUGGEST(4), but sends `LEARN(slot 2)` only *after* collecting p0's
    ACCEPT for slot 2. FIFO then delivers them *in that order*:

    #v(0.3em)
    #align(center)[
      #cetz.canvas({
        import cetz.draw: *
        rect((-1.2, 0.95), (6.0, -3.2), stroke: none)
        lifelines2(2.9, 0, "p2", 4.8, "p1")
        if i >= 1 {
          msg((0, -0.6), (4.8, -1.3), "1. ACCEPT(slot 4)", clr: cP2, t: 0.5, dy: 0.17)
          note((4.8 + 0.15, -1.3), [fabricates no-op(2)], clr: cBad, anchor: "west", size: 0.5em)
        }
        if i >= 2 {
          msg((0, -1.8), (4.8, -2.5), "2. LEARN(slot 2)", clr: cLrn, t: 0.5, dy: 0.17)
          note((4.8 + 0.15, -2.5), [too late], clr: cBad, anchor: "west", size: 0.5em)
        }
      })
    ]

    #if i >= 2 [
      #v(0.2em)
      #text(size: 0.8em, fill: luma(90))[Arrange p1's SUGGEST(4) to reach p2
        before p0's ACCEPT(2) does -- then the channel order is exactly this.
        No FIFO rule is broken.]
    ]
  ]
})

#slide(repeat: 2, self => {
  let i = self.subslide
  [
    == Phase E -- the real outcome arrives too late

    #cetz.canvas({
      import cetz.draw: *
      rect((-2.6, 1.2), (11.4, -3.4), stroke: none)
      lifelines(3.0)
      if i >= 1 {
        msg((P2, -0.7), (P1, -1.6), "LEARN(v) -- slot 2", clr: cLrn, t: 0.5)
      }
      if i >= 2 {
        xmark((P1, -1.6))
        computebox((P1, -2.0), [`learn_slot` is gated on `learned = ⊥`, #linebreak() but `learned[2] = no-op`: *LEARN dropped*], anchor: "north")
      }
    })

    #if i >= 2 [
      #ledger(
        ([0], [0], [$v$], [$v$]),
        ([1], [$-1$], [$bot$], [no-op]),
        ([0], [0], [$v$], [$v$]),
        [5], hi: ("p1lr",),
      )
    ]
  ]
})

// ─────────────────────────────────────────────────────────────────────────────
// Punchline + analysis
// ─────────────────────────────────────────────────────────────────────────────

#focus-slide[
  Two correct servers commit #text(fill: cAcc, weight: "bold")[v]. \
  A third correct server commits #text(fill: rgb("#ff8a80"), weight: "bold")[no-op]. \
  #v(0.5em)
  #text(size: 0.78em)[Same slot, no crash, no message loss -- only a false
    suspicion and a concurrent block-revoke.
    #text(fill: cAcc, weight: "bold")[Agreement] and
    #text(fill: cAcc, weight: "bold")[Total Order] are broken, permanently.]
]

#slide[
  == Why none of the safety nets catch it

  #text(weight: "bold")[Rule 4 (re-suggest on no-op)] fires only at the
  *proposer* whose value was overwritten by a no-op. The proposer is p2, and p2
  learned `v` (not no-op). So Rule 4 never triggers; nobody re-suggests `v`.

  #pause
  #v(0.4em)
  #text(weight: "bold")[Revocation's own Phase 1] would normally heal the split
  -- a revoker collects ACKs, discovers `v` was accepted, and re-proposes it.
  But p1 wrote `learned[2] = no-op` through the `est_index` shortcut, and *every*
  slot-2 handler (including ACK collection) is gated on `learned = ⊥`.

  #pause
  #v(0.4em)
  #align(center)[#text(weight: "bold", fill: cBad)[The fabricated no-op freezes
    the slot before the safe path can ever run.]]
]

#focus-slide[
  The inference treats an *absence* of a suggestion as a *skip*.
  #v(0.5em)
  #text(size: 0.8em)[Once a proposal can be #text(fill: cAcc, weight: "bold")[received and rejected]
    by a revoke, an absence is no longer trustworthy -- so the optimization
    synthesizes a `no-op` over a slot the coordinator actually filled.]
]

#slide[
  == The fix

  #text(weight: "bold")[1. Safety -- ballot guard in `fill_q_skips`.] Only learn
  a no-op for slot `j` when the local `prepared_ballot[j]` is still the owner's
  implicit `(0, q)`. If any higher ballot is present, a revoker is active and
  the gap-fill defers to consensus.

  #pause
  #v(0.3em)
  #align(center)[#text(fill: cP2, size: 0.95em)[In Phase D, `prepared_ballot[2] = (1, p1) != (0, p2)` -- so slot 2 is *not* learned as no-op.]]

  #pause
  #v(0.4em)
  #text(weight: "bold")[2. Liveness -- NACK -> owner self-revoke.] A rejected
  ballot-0 SUGGEST returns a NACK carrying the higher ballot; the owner
  self-revokes, Phase 1 discovers the accepted value, and the slot converges.

  #pause
  #v(0.4em)
  #text(size: 0.85em, fill: luma(90))[Both together: opt 1+2+3 keeps Rule 2
    throughput in the common case and falls back to proper Paxos when a revoke
    is active. See `Mencius_opt1_2_3_fixed.spur`.]
]

#slide[
  == Reproducing it

  #text(size: 0.92em)[
    ```bash
    cargo run --release --manifest-path spur/Cargo.toml --bin spur -- \
      explore -e standard --config scheduler_configs/mencius_nocrash.json \
      -y --output-dir out bin/spur/mencius/Mencius_opt1_2_3.spur
    ./porcupine/main -input out -type duckdb -model kv -output-dir out
    ```
  ]

  #v(0.3em)
  - Expected: *Some runs are NOT linearizable* -- ~8 of ~708 runs, more than the
    ad-hoc opt1_2 variant because the β-window always revokes slot 5 too.
  - `debug combined --run-id N` on a failing run shows
    `Revoke start: slot=2 ballot=(1,...)` and slot-2 divergence (`no-op` on the
    revoker vs committed `uid` elsewhere). The `_fixed` spec is linearizable.

  #v(0.3em)
  #text(size: 0.85em, fill: luma(100))[Full write-up: `bug_opt1_2_3.md`.]
]
