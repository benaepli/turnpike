//! The linear script through Z3 in incremental QF_LRA: one context per
//! thread, a solver reset between runs, a push and pop around each trial.

use crate::linear::{Row, Script, Step};
use crate::drive::Outcome;
use z3::ast::{Bool, Real};
use z3::{Context, SatResult, Solver};

fn constant<'c>(ctx: &'c Context, q: &num_rational::Ratio<i128>) -> Real<'c> {
    Real::from_real_str(ctx, &q.numer().to_string(), &q.denom().to_string()).expect("a rational")
}

fn formula<'c>(ctx: &'c Context, row: &Row, unknowns: &[Real<'c>]) -> Bool<'c> {
    let mut parts: Vec<Real<'c>> = vec![constant(ctx, &row.constant)];
    for (u, c) in &row.terms {
        parts.push(Real::mul(ctx, &[&constant(ctx, c), &unknowns[*u]]));
    }
    let refs: Vec<&Real<'c>> = parts.iter().collect();
    let sum = Real::add(ctx, &refs);
    let zero = Real::from_real(ctx, 0, 1);
    if row.strict { sum.gt(&zero) } else { sum.ge(&zero) }
}

pub fn play(ctx: &Context, solver: &Solver, script: &Script) -> Outcome {
    let mut outcome = Outcome { open: Vec::new(), sites: Vec::new(), report: Default::default(), _log: Vec::new() };
    solver.reset();
    let mut unknowns: Vec<Real> = Vec::with_capacity(script.unknowns);
    for step in &script.steps {
        match step {
            Step::Dead(_) | Step::Glue { .. } => {}
            Step::Horizon(u, h) => solver.assert(&formula(ctx, &spur_time::Row { terms: vec![(*u, -spur_time::Q::from_integer(1))], constant: *h, strict: false }, &unknowns)),
            Step::Unknown(index, _) | Step::Lasting(index) => unknowns.push(Real::new_const(ctx, format!("x{index}"))),
            Step::Require(rows) => rows.iter().for_each(|r| solver.assert(&formula(ctx, r, &unknowns))),
            Step::Decide { taken, other, site, outcome: result } => {
                let mut open = false;
                for conjunction in other {
                    solver.push();
                    conjunction.iter().for_each(|r| solver.assert(&formula(ctx, r, &unknowns)));
                    open = solver.check() == SatResult::Sat;
                    solver.pop(1);
                    if open {
                        break;
                    }
                }
                outcome.open.push(Some(open));
                outcome.sites.push((*site, *result));
                taken.iter().for_each(|r| solver.assert(&formula(ctx, r, &unknowns)));
            }
        }
    }
    if solver.check() != SatResult::Sat {
        outcome.report.rejected += 1;
    }
    outcome
}
