//! A run as a solver-neutral sequence of linear steps.
//!
//! Every unknown has an index. A row means `sum(coefficient * unknown) +
//! constant >= 0`, or `> 0` when strict. A comparison is one form whose two
//! outcomes are complementary bounds on it, so a solver needs one row for it.

use crate::general::Level;
use crate::model::{Q, Requirement, Run};
use std::collections::BTreeMap;

pub use spur_time::{Row, Step};

#[derive(Clone)]
pub struct Script {
    pub unknowns: usize,
    pub steps: Vec<Step>,
    /// Requirements this level cannot write as a linear row.
    pub unsupported: u64,
    /// Unknowns the whole run shares, such as named durations. Moving one
    /// moves every row that mentions it, so a solver may prefer to try an
    /// outcome with them held where they are first.
    pub lasting: Vec<usize>,
    /// The time unknowns, in order. Each is made by an `Unknown` step that
    /// starts it at the time before it, followed at once by the row that
    /// orders it after that one.
    pub times: Vec<usize>,
}

struct Builder<'r> {
    run: &'r Run,
    level: Level,
    times: Vec<usize>,
    durations: BTreeMap<String, usize>,
    rates: BTreeMap<usize, usize>,
    next: usize,
    steps: Vec<Step>,
    unsupported: u64,
    band: (Q, Q),
}

fn one() -> Q {
    Q::from_integer(1)
}

impl<'r> Builder<'r> {
    fn fresh(&mut self) -> usize {
        self.fresh_at(None)
    }

    fn fresh_at(&mut self, like: Option<(usize, Q)>) -> usize {
        let index = self.next;
        self.next += 1;
        self.steps.push(Step::Unknown(index, like));
        index
    }

    fn bound(&mut self, unknown: usize, low: Option<Q>, high: Option<Q>, strict: bool) {
        let mut rows = Vec::new();
        if let Some(low) = low {
            rows.push(Row { terms: vec![(unknown, one())], constant: -low, strict });
        }
        if let Some(high) = high {
            rows.push(Row { terms: vec![(unknown, -one())], constant: high, strict });
        }
        self.steps.push(Step::Require(rows));
    }

    /// The unknown standing for `1 / rate` of `node`.
    fn inverse_rate(&mut self, node: usize) -> usize {
        if let Some(u) = self.rates.get(&node) {
            return *u;
        }
        let u = self.fresh();
        self.rates.insert(node, u);
        let (low, high) = (one() / self.band.1, one() / self.band.0);
        self.bound(u, Some(low), Some(high), false);
        u
    }

    fn row(&mut self, requirement: &Requirement) -> Option<Row> {
        let form = &requirement.form;
        let nodes: std::collections::BTreeSet<Option<usize>> = form.c.keys().map(|e| self.run.clock_of(*e)).collect();
        let total: Q = form.c.values().cloned().sum();
        let node = nodes.iter().next().copied().flatten();
        let mut terms: BTreeMap<usize, Q> = BTreeMap::new();
        let mut constant = Q::from_integer(0);
        let add = |terms: &mut BTreeMap<usize, Q>, u: usize, c: Q| {
            *terms.entry(u).or_insert_with(|| Q::from_integer(0)) += c;
        };
        if nodes.len() <= 1 && total == Q::from_integer(0) {
            // Divided by the clock's rate: times stay bare, the rest is
            // scaled by the reciprocal rate.
            for (event, c) in &form.c {
                add(&mut terms, self.times[*event], *c);
            }
            let symbolic_rate = self.level == Level::Rates && node.is_some();
            let scale = node.map_or(one(), |n| one() / self.run.rate_of(n));
            if symbolic_rate {
                let rest: Q = form.k + form.d.iter().map(|(f, c)| c * self.run.durations[f]).sum::<Q>();
                let s = self.inverse_rate(node.unwrap());
                add(&mut terms, s, rest);
            } else {
                constant += form.k * scale;
                for (field, c) in &form.d {
                    match self.durations.get(field) {
                        Some(d) => add(&mut terms, *d, c * scale),
                        None => constant += c * self.run.durations[field] * scale,
                    }
                }
            }
        } else {
            if self.level == Level::Rates {
                return None;
            }
            for (event, c) in &form.c {
                let rate = self.run.clock_of(*event).map_or(one(), |n| self.run.rate_of(n));
                add(&mut terms, self.times[*event], c * rate);
            }
            constant += form.k;
            for (field, c) in &form.d {
                match self.durations.get(field) {
                    Some(d) => add(&mut terms, *d, *c),
                    None => constant += c * self.run.durations[field],
                }
            }
        }
        let terms = terms.into_iter().filter(|(_, c)| *c != Q::from_integer(0)).collect();
        Some(Row { terms, constant, strict: requirement.strict })
    }

    fn rows(&mut self, requirements: &[Requirement]) -> Option<Vec<Row>> {
        requirements.iter().map(|r| self.row(r)).collect()
    }
}

pub fn script(run: &Run, level: Level, rho: &Q) -> Script {
    script_anchored(run, level, rho, Anchor::None)
}

/// What fixes the scale of open durations.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Anchor {
    None,
    /// The field named `election` is one.
    Election,
    /// All named durations sum to one. Needs no knowledge of the spec, and
    /// the sum is positive wherever the durations are.
    Sum,
}

/// As `script`, with the scale of open durations fixed by `anchor`. When every
/// constraint is homogeneous in the times and the durations, the feasible set
/// is a cone and fixing its scale removes no outcome; it only gives the
/// values a unit. A constraint with an absolute constant breaks that.
pub fn script_anchored(run: &Run, level: Level, rho: &Q, anchor: Anchor) -> Script {
    let mut b = Builder {
        run,
        level,
        times: Vec::new(),
        durations: BTreeMap::new(),
        rates: BTreeMap::new(),
        next: 0,
        steps: Vec::new(),
        unsupported: 0,
        band: (one() - rho, one() + rho),
    };
    if level == Level::Durations {
        for field in run.durations.keys() {
            let u = b.fresh();
            b.durations.insert(field.clone(), u);
            b.bound(u, Some(Q::from_integer(0)), None, true);
        }
        // The timing block the three lease specs share.
        let d = b.durations.clone();
        if let (Some(&e), Some(&h), Some(&l), Some(&m)) = (d.get("election"), d.get("heartbeat"), d.get("lease"), d.get("margin")) {
            let zero = Q::from_integer(0);
            let row = |terms: Vec<(usize, Q)>, strict: bool| Row { terms, constant: zero, strict };
            b.steps.push(Step::Require(vec![
                row(vec![(l, one()), (e, -one())], false),
                row(vec![(e, one()), (l, -one())], false),
                row(vec![(e, one()), (h, -one())], true),
                row(vec![(l, one()), (m, -one())], true),
                // election * rate_min - (lease - margin) * rate_max > 0
                row(vec![(e, b.band.0), (l, -b.band.1), (m, b.band.1)], true),
            ]));
            if anchor == Anchor::Election {
                b.steps.push(Step::Require(vec![
                    Row { terms: vec![(e, one())], constant: -one(), strict: false },
                    Row { terms: vec![(e, -one())], constant: one(), strict: false },
                ]));
            }
        }
    }
    if anchor == Anchor::Sum && !b.durations.is_empty() {
        let all: Vec<usize> = b.durations.values().copied().collect();
        b.steps.push(Step::Require(vec![
            Row { terms: all.iter().map(|d| (*d, one())).collect(), constant: -one(), strict: false },
            Row { terms: all.iter().map(|d| (*d, -one())).collect(), constant: one(), strict: false },
        ]));
    }
    for (fresh, constraint) in run.stages() {
        if fresh {
            let t = b.fresh_at(b.times.last().map(|p| (*p, one())));
            let floor = match b.times.last() {
                None => Row { terms: vec![(t, one())], constant: Q::from_integer(0), strict: false },
                Some(p) => Row { terms: vec![(*p, -one()), (t, one())], constant: Q::from_integer(0), strict: false },
            };
            b.times.push(t);
            b.steps.push(Step::Require(vec![floor]));
        }
        let Some(constraint) = constraint else { continue };
        let Some(taken) = b.rows(&constraint.taken) else {
            b.unsupported += 1;
            continue;
        };
        match constraint.site {
            Some(site) => {
                let other: Vec<Vec<Row>> = constraint.other.iter().filter_map(|c| b.rows(c)).collect();
                b.steps.push(Step::Decide { taken, other, site, outcome: constraint.outcome });
            }
            None => b.steps.push(Step::Require(taken)),
        }
    }
    // Mark each unknown dead after the last step that mentions it.
    let mut last: BTreeMap<usize, usize> = BTreeMap::new();
    for (at, step) in b.steps.iter().enumerate() {
        let mut note = |rows: &[Row]| {
            for r in rows {
                for (u, _) in &r.terms {
                    last.insert(*u, at);
                }
            }
        };
        match step {
            Step::Unknown(u, like) => {
                last.insert(*u, at);
                if let Some((like, _)) = like {
                    last.insert(*like, at);
                }
            }
            Step::Require(rows) => note(rows),
            Step::Decide { taken, other, .. } => {
                note(taken);
                other.iter().for_each(|c| note(c));
            }
            Step::Dead(_) | Step::Glue { .. } | Step::Lasting(_) => {}
        }
    }
    let mut dying: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for (u, at) in last {
        dying.entry(at).or_default().push(u);
    }
    let mut steps = Vec::with_capacity(b.steps.len() * 2);
    for (at, step) in b.steps.into_iter().enumerate() {
        steps.push(step);
        for u in dying.remove(&at).unwrap_or_default() {
            steps.push(Step::Dead(u));
        }
    }
    let lasting = b.durations.values().copied().collect();
    Script { unknowns: b.next, steps, unsupported: b.unsupported, lasting, times: b.times }
}
