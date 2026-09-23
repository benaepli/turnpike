//! An online engine log against Z3, decision by decision: every answered
//! decision's other outcome is asked of Z3 over the rows the run had
//! accepted by then, and the two answers compared.
//!
//! The log is the one `spur` writes with `SPUR_ENGINE_LOG_DIR` set, under
//! the `time-constraints` feature: one line an entry, `#` between runs.

use spur_time::{Q, Row};
use z3::ast::{Bool, Real};
use z3::{Context, SatResult, Solver};

#[derive(Default, Debug)]
pub struct Agreement {
    pub runs: u64,
    pub answered: u64,
    pub open: u64,
    /// The engine said open where Z3 says closed, and the other way round.
    pub false_open: u64,
    pub false_closed: u64,
    /// Decisions Z3 did not settle within its time limit.
    pub undecided: u64,
    /// Accepted rows Z3 finds cannot hold with the rest.
    pub inconsistent_runs: u64,
    /// Outcomes the run took whose rows the engine could not accept.
    pub rejected_accepts: u64,
}

fn rational(text: &str) -> Q {
    match text.split_once('/') {
        Some((n, d)) => Q::new(n.parse().unwrap(), d.parse().unwrap()),
        None => Q::from_integer(text.parse().unwrap()),
    }
}

fn rows(text: &str) -> Vec<Row> {
    text.split(';')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|r| {
            let mut parts = r.split_whitespace();
            let strict = parts.next().unwrap() == "1";
            let constant = rational(parts.next().unwrap());
            let terms = parts
                .map(|t| {
                    let (u, c) = t.split_once(':').unwrap();
                    (u.parse().unwrap(), rational(c))
                })
                .collect();
            Row { terms, constant, strict }
        })
        .collect()
}

fn constant<'c>(ctx: &'c Context, q: &Q) -> Real<'c> {
    Real::from_real_str(ctx, &q.numer().to_string(), &q.denom().to_string()).expect("a rational")
}

fn formula<'c>(ctx: &'c Context, row: &Row, unknowns: &mut Vec<Real<'c>>) -> Bool<'c> {
    let mut parts: Vec<Real<'c>> = vec![constant(ctx, &row.constant)];
    for (u, c) in &row.terms {
        while unknowns.len() <= *u {
            let i = unknowns.len();
            unknowns.push(Real::new_const(ctx, format!("x{i}")));
        }
        parts.push(Real::mul(ctx, &[&constant(ctx, c), &unknowns[*u]]));
    }
    let refs: Vec<&Real<'c>> = parts.iter().collect();
    let sum = Real::add(ctx, &refs);
    let zero = Real::from_real(ctx, 0, 1);
    if row.strict { sum.gt(&zero) } else { sum.ge(&zero) }
}

/// Plays one run's log through `solver`.
fn run(ctx: &Context, solver: &Solver, lines: &[&str], tally: &mut Agreement) {
    solver.reset();
    let mut unknowns: Vec<Real> = Vec::new();

    for line in lines {
        let (op, rest) = line.split_at(1);
        let rest = rest.trim();
        match op {
            "u" | "l" => {
                let index: usize = rest.split_whitespace().next().unwrap().parse().unwrap();

                while unknowns.len() <= index {
                    let i = unknowns.len();
                    unknowns.push(Real::new_const(ctx, format!("x{i}")));
                }
            }
            "r" => rows(rest).iter().for_each(|r| solver.assert(&formula(ctx, r, &mut unknowns))),
            // Rows the engine found could not hold were withdrawn.
            "R" | "d" | "g" => {}
            "c" => {
                let mut parts = rest.split('|');
                let head: Vec<&str> = parts.next().unwrap().split_whitespace().collect();
                let (answer, took, implied) = (head[2], head[3] == "1", head[4] == "1");
                let rejected = head.get(5) == Some(&"1");
                tally.rejected_accepts += u64::from(rejected);
                let taken = rows(parts.next().unwrap_or(""));
                let other: Vec<Vec<Row>> = parts.map(rows).collect();
                if answer != "-" {
                    tally.answered += 1;
                    let mut z3_open = Some(false);
                    for conjunction in &other {
                        solver.push();
                        conjunction.iter().for_each(|r| solver.assert(&formula(ctx, r, &mut unknowns)));
                        match solver.check() {
                            SatResult::Sat => z3_open = Some(true),
                            SatResult::Unknown if z3_open != Some(true) => z3_open = None,
                            _ => {}
                        }
                        solver.pop(1);
                        if z3_open == Some(true) {
                            break;
                        }
                    }
                    let open = answer == "1";

                    tally.open += u64::from(open);
                    match z3_open {
                        None => tally.undecided += 1,
                        Some(z) if z != open => {

                            if open {
                                tally.false_open += 1;
                            } else {
                                tally.false_closed += 1;
                            }
                        }
                        _ => {}
                    }
                }
                let accepted: &[Row] = if implied || rejected { &[] } else if took { &other[0] } else { &taken };

                accepted.iter().for_each(|r| solver.assert(&formula(ctx, r, &mut unknowns)));
            }
            other => panic!("unknown log entry {other}"),
        }
    }
    if solver.check() == SatResult::Unsat {

        tally.inconsistent_runs += 1;
    }
}

/// Every run of every log file in `dir`.
pub fn agree(dir: &std::path::Path, limit: usize) -> Agreement {
    let ctx = Context::new(&z3::Config::new());
    let solver = Solver::new(&ctx);
    let mut params = z3::Params::new(&ctx);
    params.set_u32("timeout", 10_000);
    solver.set_params(&params);
    let mut tally = Agreement::default();
    let mut files: Vec<_> = std::fs::read_dir(dir).expect("the log directory").map(|e| e.unwrap().path()).collect();
    files.sort();
    for file in files {
        let text = std::fs::read_to_string(&file).unwrap();
        for block in text.split("#\n").filter(|b| !b.trim().is_empty()) {
            if tally.runs as usize >= limit {
                return tally;
            }
            let lines: Vec<&str> = block.lines().filter(|l| !l.is_empty()).collect();
            tally.runs += 1;
            run(&ctx, &solver, &lines, &mut tally);
            if tally.runs % 200 == 0 {
                eprintln!("{tally:?}");
            }
        }
    }
    tally
}
