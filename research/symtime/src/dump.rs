//! A run's engine operations as text, for test fixtures.
//!
//! One operation a line:
//!
//! ```text
//! u INDEX [LIKE SCALE]        a plain unknown
//! l INDEX                     a duration
//! t INDEX ENDS                a time; ENDS 1 forgets the time before it
//! r ROW; ROW; ...             rows required
//! d INDEX                     forget
//! c SITE OUTCOME | ROWS | ROWS | ...   a decision: taken, then each other conjunction
//! e ANSWERS                   the expected answers: 0 closed, 1 open, - none
//! ```
//!
//! A row is `STRICT CONSTANT U:C U:C ...` with rationals written `n/d`.

use crate::linear::Script;
use spur_time::{Q, Row, Step};
use std::fmt::Write;

fn q(v: &Q) -> String {
    if *v.denom() == 1 { v.numer().to_string() } else { format!("{}/{}", v.numer(), v.denom()) }
}

fn row(r: &Row) -> String {
    let mut out = format!("{} {}", u8::from(r.strict), q(&r.constant));
    for (u, c) in &r.terms {
        let _ = write!(out, " {u}:{}", q(c));
    }
    out
}

fn rows(list: &[Row]) -> String {
    list.iter().map(row).collect::<Vec<_>>().join("; ")
}

/// The script as the operations the engine is given, in the order the
/// harness gives them, then the expected answers.
pub fn dump(script: &Script, answers: &[Option<bool>]) -> String {
    let mut out = String::new();
    let mut is_time = vec![false; script.unknowns];
    for t in &script.times {
        is_time[*t] = true;
    }
    let mut last_time: Option<usize> = None;
    let mut steps = script.steps.iter().peekable();
    while let Some(step) = steps.next() {
        match step {
            Step::Unknown(index, like) => {
                if is_time[*index] {
                    steps.next();
                    let ends = matches!(steps.peek(), Some(Step::Dead(u)) if Some(*u) == last_time);
                    if ends {
                        steps.next();
                    }
                    let _ = writeln!(out, "t {index} {}", u8::from(ends));
                    last_time = Some(*index);
                } else if script.lasting.contains(index) {
                    let _ = writeln!(out, "l {index}");
                } else {
                    match like {
                        Some((l, s)) => {
                            let _ = writeln!(out, "u {index} {l} {}", q(s));
                        }
                        None => {
                            let _ = writeln!(out, "u {index}");
                        }
                    }
                }
            }
            Step::Require(list) => {
                let _ = writeln!(out, "r {}", rows(list));
            }
            Step::Dead(u) => {
                let _ = writeln!(out, "d {u}");
            }
            Step::Decide { taken, other, site, outcome } => {
                let mut line = format!("c {site} {} | {}", u8::from(*outcome), rows(taken));
                for c in other {
                    let _ = write!(line, " | {}", rows(c));
                }
                let _ = writeln!(out, "{line}");
            }
            Step::Lasting(_) | Step::Glue { .. } => {}
        }
    }
    let expected: String = answers.iter().map(|a| match a {
        Some(true) => '1',
        Some(false) => '0',
        None => '-',
    }).collect();
    let _ = writeln!(out, "e {expected}");
    out
}
