//! The same run played through a general solver, with less of it fixed.
//!
//! Concrete   rates and named durations are the run's own numbers
//! Durations  named durations are unknowns bound only by the spec's
//!            requirements; rates are the run's own
//! Rates      durations are the run's own and each node's rate is an unknown
//!            inside the band, fixed for the run
//! Both       durations and rates are unknowns
//!
//! A comparison only ever involves readings of one clock, and its reading
//! coefficients sum to zero, so dividing it by that clock's rate leaves
//! `sum(c * T) + (durations and constants) / rate`. With `s = 1 / rate` as the
//! unknown this is linear when the durations are numbers, and a product of
//! two parameters, never of a time, when they are not. `Naive` keeps the
//! undivided `rate * T` form for comparison.
//!
//! Readings are not floored here, as in the difference solver's pass.

use crate::model::{Q, Requirement, Run};
use std::collections::BTreeMap;
use z3::ast::{Ast, Bool, Real};
use z3::{Context, Params, SatResult, Solver};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Level {
    Concrete,
    Durations,
    Rates,
    Both,
    Naive,
}

pub struct Outcome {
    /// Per comparison: whether the other outcome was satisfiable.
    pub open: Vec<Option<bool>>,
    pub sites: Vec<(usize, bool)>,
    pub consistent: bool,
    pub undivided: u64,
}

fn real<'c>(ctx: &'c Context, q: &Q) -> Real<'c> {
    Real::from_real_str(ctx, &q.numer().to_string(), &q.denom().to_string()).expect("a rational")
}

struct Player<'c, 'r> {
    ctx: &'c Context,
    run: &'r Run,
    level: Level,
    times: Vec<Real<'c>>,
    durations: BTreeMap<String, Real<'c>>,
    rates: BTreeMap<usize, Real<'c>>,
    band: (Q, Q),
    solver: &'c Solver<'c>,
    undivided: u64,
}

impl<'c, 'r> Player<'c, 'r> {
    fn symbolic_rates(&self) -> bool {
        matches!(self.level, Level::Rates | Level::Both | Level::Naive)
    }

    /// The node's rate, or with `inverse` its reciprocal.
    fn rate(&mut self, node: usize, inverse: bool) -> Real<'c> {
        if !self.symbolic_rates() {
            let r = self.run.rate_of(node);
            return real(self.ctx, &if inverse { Q::from_integer(1) / r } else { r });
        }
        if let Some(r) = self.rates.get(&node) {
            return r.clone();
        }
        let r = Real::new_const(self.ctx, format!("r{node}"));
        let one = Q::from_integer(1);
        let (low, high) = if inverse { (one / self.band.1, one / self.band.0) } else { (self.band.0, self.band.1) };
        self.solver.assert(&r.ge(&real(self.ctx, &low)));
        self.solver.assert(&r.le(&real(self.ctx, &high)));
        self.rates.insert(node, r.clone());
        r
    }

    fn duration(&mut self, field: &str) -> Real<'c> {
        if matches!(self.level, Level::Concrete | Level::Rates) {
            return real(self.ctx, &self.run.durations[field]);
        }
        self.durations[field].clone()
    }

    fn holds(&mut self, requirement: &Requirement) -> Bool<'c> {
        let form = &requirement.form;
        let nodes: std::collections::BTreeSet<Option<usize>> = form.c.keys().map(|e| self.run.clock_of(*e)).collect();
        let total: Q = form.c.values().cloned().sum();
        let one_clock = nodes.len() == 1 && total == Q::from_integer(0);
        let divided = one_clock && self.level != Level::Naive;
        if !divided && !form.c.is_empty() && self.level != Level::Naive {
            self.undivided += 1;
        }
        let mut terms: Vec<Real<'c>> = Vec::new();
        // What multiplies the times, and what multiplies everything else.
        let node = nodes.iter().next().copied().flatten();
        let unit = Real::from_real(self.ctx, 1, 1);
        let (on_times, on_rest) = match (divided, node) {
            (true, Some(n)) => (None, self.rate(n, true)),
            _ => (Some(()), unit.clone()),
        };
        for (event, c) in &form.c {
            let time = self.times[self.run.group_of(*event)].clone();
            let rate = match (on_times, self.run.clock_of(*event)) {
                (Some(()), Some(n)) => self.rate(n, false),
                _ => unit.clone(),
            };
            terms.push(Real::mul(self.ctx, &[&real(self.ctx, c), &rate, &time]));
        }
        terms.push(Real::mul(self.ctx, &[&real(self.ctx, &form.k), &on_rest]));
        for (field, c) in &form.d {
            let d = self.duration(field);
            terms.push(Real::mul(self.ctx, &[&real(self.ctx, c), &d, &on_rest]));
        }
        let refs: Vec<&Real<'c>> = terms.iter().collect();
        let sum = Real::add(self.ctx, &refs);
        let zero = Real::from_real(self.ctx, 0, 1);
        if requirement.strict { sum.gt(&zero) } else { sum.ge(&zero) }
    }
}

pub fn play(ctx: &Context, solver: &Solver, run: &Run, level: Level, rho: &Q) -> Outcome {
    solver.reset();
    let one = Q::from_integer(1);
    let mut player = Player {
        ctx,
        run,
        level,
        times: Vec::new(),
        durations: BTreeMap::new(),
        rates: BTreeMap::new(),
        band: (one - rho, one + rho),
        solver,
        undivided: 0,
    };
    let zero = Real::from_real(ctx, 0, 1);
    if matches!(level, Level::Durations | Level::Both | Level::Naive) {
        for field in run.durations.keys() {
            let d = Real::new_const(ctx, format!("d_{field}"));
            solver.assert(&d.gt(&zero));
            player.durations.insert(field.clone(), d);
        }
        // The timing block the three lease specs share.
        let d = &player.durations;
        if let (Some(e), Some(h), Some(l), Some(m)) = (d.get("election"), d.get("heartbeat"), d.get("lease"), d.get("margin")) {
            solver.assert(&l._eq(e));
            solver.assert(&h.lt(e));
            solver.assert(&m.lt(l));
            let slack = Real::sub(ctx, &[l, m]);
            let left = Real::mul(ctx, &[&slack, &real(ctx, &player.band.1)]);
            let right = Real::mul(ctx, &[e, &real(ctx, &player.band.0)]);
            solver.assert(&left.lt(&right));
        }
    }
    let mut outcome = Outcome { open: Vec::new(), sites: Vec::new(), consistent: true, undivided: 0 };
    for (fresh, constraint) in run.stages() {
        if fresh.is_some() {
            let t = Real::new_const(ctx, format!("t{}", player.times.len()));
            let floor = player.times.last().cloned().unwrap_or_else(|| zero.clone());
            solver.assert(&t.ge(&floor));
            player.times.push(t);
        }
        let Some(constraint) = constraint else { continue };
        if let Some(site) = constraint.site {
            let mut open = Some(false);
            for conjunction in &constraint.other {
                solver.push();
                for r in conjunction {
                    let b = player.holds(r);
                    solver.assert(&b);
                }
                match solver.check() {
                    SatResult::Sat => open = Some(true),
                    SatResult::Unknown if open != Some(true) => open = None,
                    _ => {}
                }
                solver.pop(1);
                if open == Some(true) {
                    break;
                }
            }
            outcome.open.push(open);
            outcome.sites.push((site, constraint.outcome));
        }
        for r in &constraint.taken {
            let b = player.holds(r);
            solver.assert(&b);
        }
    }
    outcome.consistent = solver.check() == SatResult::Sat;
    outcome.undivided = player.undivided;
    outcome
}

pub fn solver<'c>(ctx: &'c Context, level: Level, timeout_ms: u32) -> Solver<'c> {
    let logic = if matches!(level, Level::Both | Level::Naive) { "QF_NRA" } else { "QF_LRA" };
    let solver = Solver::new_for_logic(ctx, logic).expect("a solver for the logic");
    let mut params = Params::new(ctx);
    params.set_u32("timeout", timeout_ms);
    solver.set_params(&params);
    solver
}
