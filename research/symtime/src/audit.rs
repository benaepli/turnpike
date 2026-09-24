//! The audit logs a symbolic session writes (`time.audit_share`, under
//! `<output>/audit/`) played again through a fresh engine with the calls the
//! simulator made, each decision's answer compared with the one recorded.
//!
//! A run whose log names a lasting unknown is skipped: the log does not keep
//! the value an open duration started at. A withdrawn trial is logged as a
//! decision that accepts nothing, and is made again as a trial.

use spur_time::{Ask, Engine, Entry, Holds, Options, Q, Row, Take};

#[derive(Default, Debug)]
pub struct Audit {
    pub runs: u64,
    pub skipped_lasting: u64,
    pub decisions: u64,
    pub flips: u64,
    pub trials: u64,
    pub answers_differ: u64,
    /// Decisions whose replayed outcome differs from the record, by field.
    pub took_differs: u64,
    pub implied_differs: u64,
    pub rejected_differs: u64,
    pub requires_differ: u64,
    /// Runs with any difference.
    pub runs_differing: u64,
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

/// Plays one run's log. False when it differs anywhere.
fn run(lines: &[&str], tally: &mut Audit) -> bool {
    // The horizon the run was given, which its engine applies to each time.
    let horizon = lines.iter().find(|l| l.starts_with("h ")).map(|l| rational(l.split_whitespace().nth(2).unwrap()));
    let mut e = Engine::new(Options { horizon, ..Options::default() }, 0, 1024);
    let mut same = true;
    let mut timed = false;
    let mut i = 0;
    while i < lines.len() {
        let (op, rest) = lines[i].split_at(1);
        let rest = rest.trim();
        let parts: Vec<&str> = rest.split_whitespace().collect();
        // A time is its unknown, its ordering row, the engine's glues and
        // the death of the time before it when that had finished.
        let first_time = op == "u" && parts.len() == 1 && !timed && lines.get(i + 1).is_some_and(|l| *l == format!("r 0 0 {}:1", parts[0]));
        if op == "u" && (parts.len() == 3 || first_time) {
            let mut j = i + 2;
            while lines.get(j).is_some_and(|l| l.starts_with('g') || l.starts_with('h')) {
                j += 1;
            }
            let ends = parts.len() == 3 && lines.get(j).is_some_and(|l| *l == format!("d {}", parts[1]));
            e.time(ends);
            timed = true;
            i = if ends { j + 1 } else { i + 2 };
            continue;
        }
        match op {
            "u" => {
                e.unknown(None);
            }
            "r" | "R" => {
                let held = e.require(rows(rest)) == Holds::Holds;
                if held != (op == "r") {
                    tally.requires_differ += 1;
                    same = false;
                }
            }
            "d" => e.forget(parts[0].parse().unwrap()),
            // Played by the engine itself as each time is made.
            "g" | "h" => {}
            "c" => {
                let mut sections = rest.split('|');
                let head: Vec<&str> = sections.next().unwrap().split_whitespace().collect();
                let (site, outcome) = (head[0].parse().unwrap(), head[1] == "1");
                let (took, implied, rejected) = (head[3] == "1", head[4] == "1", head[5] == "1");
                let taken = rows(sections.next().unwrap_or(""));
                let other: Vec<Vec<Row>> = sections.map(rows).collect();
                tally.decisions += 1;
                if taken.is_empty() && other.len() == 1 && !took {
                    tally.trials += 1;
                    let answer = e.trial(site, outcome, other[0].clone());
                    let recorded = match head[2] {
                        "1" => Some(true),
                        "0" => Some(false),
                        _ => None,
                    };
                    if answer != recorded {
                        tally.answers_differ += 1;
                        same = false;
                    }
                } else if other.is_empty() {
                    e.decide(site, outcome, taken, Vec::new(), Ask::Never);
                } else {
                    tally.flips += 1;
                    let replayed = e.try_take(site, outcome, other[0].clone(), taken) == Some(Take::Taken);
                    if replayed != took {
                        tally.took_differs += 1;
                        same = false;
                    }
                }
                if let Some(Entry::Decide(a)) = e.log().last() {
                    if a.implied != implied {
                        tally.implied_differs += 1;
                        same = false;
                    }
                    if a.rejected != rejected {
                        tally.rejected_differs += 1;
                        same = false;
                    }
                }
            }
            other => panic!("unknown entry {other}"),
        }
        i += 1;
    }
    same
}

pub fn audit(dir: &std::path::Path, limit: usize) -> Audit {
    let mut tally = Audit::default();
    let mut files: Vec<_> = std::fs::read_dir(dir).expect("the audit directory").map(|e| e.unwrap().path()).collect();
    files.sort();
    for file in files {
        let text = std::fs::read_to_string(&file).unwrap();
        for block in text.split("#\n").filter(|b| !b.trim().is_empty()) {
            if tally.runs as usize >= limit {
                return tally;
            }
            let lines: Vec<&str> = block.lines().filter(|l| !l.is_empty()).collect();
            if lines.iter().any(|l| l.starts_with('l')) {
                tally.skipped_lasting += 1;
                continue;
            }
            tally.runs += 1;
            if !run(&lines, &mut tally) {
                tally.runs_differing += 1;
            }
        }
    }
    tally
}
