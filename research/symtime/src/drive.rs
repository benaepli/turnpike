//! Plays a recorded run's script through the online engine, the recorded
//! outcome standing in for the explorer's draw.

use crate::linear::Script;
use spur_time::{Arithmetic, Ask, Cause, Engine, Options, Report, State, Step};
use std::time::Instant;

/// How a script is played.
#[derive(Clone, Copy)]
pub struct Policy {
    pub opts: Options,
    /// Draw-then-verify: a comparison whose recorded outcome the assignment
    /// already witnesses skips its trial except for this share of them,
    /// chosen by a hash of the comparison's place in the run. `None` tries
    /// every comparison.
    pub draw: Option<f64>,
    /// The run concedes once solving is still going at this instant.
    pub deadline: Option<Instant>,
}

impl Policy {
    /// The policy the environment asks for: `SIMPLEX_DRAW=q`,
    /// `SIMPLEX_TIERS=n`, `SIMPLEX_PATIENCE=n`, and the arithmetic of
    /// `backend`.
    pub fn from_env(backend: &str) -> Policy {
        let mut opts = Options::default();
        if backend == "float" {
            opts.arithmetic = Arithmetic::Float;
        }
        if let Some(tiers) = std::env::var("SIMPLEX_TIERS").ok().and_then(|v| v.parse().ok()) {
            opts.tiers = tiers;
        }
        if let Some(patience) = std::env::var("SIMPLEX_PATIENCE").ok().and_then(|v| v.parse().ok()) {
            opts.patience = patience;
        }
        let draw = std::env::var("SIMPLEX_DRAW").ok().and_then(|v| v.parse().ok());
        Policy { opts, draw, deadline: None }
    }
}

pub struct Outcome {
    /// Per comparison: whether its other outcome was open; `None` when it
    /// was not asked or the run had conceded.
    pub open: Vec<Option<bool>>,
    pub sites: Vec<(usize, bool)>,
    pub report: Report,
    /// The engine's log, handed over so that it is freed after the run is
    /// timed, as the script it was built from is.
    pub _log: Vec<spur_time::Entry>,
}

impl Outcome {
    /// Comparisons with no answer.
    pub fn unanswered(&self) -> usize {
        self.open.iter().filter(|o| o.is_none()).count()
    }

    pub fn conceded(&self) -> bool {
        self.report.conceded.is_some()
    }
}

/// Whether the draw of comparison `index` at `site` is the witnessed
/// outcome when the assignment witnesses one: a seeded share `1 - q` of
/// them.
fn draws_witnessed(index: usize, site: usize, q: f64) -> bool {
    let mut h = (index as u64 ^ (site as u64) << 32).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    h ^= h >> 31;
    (h % 1000) as f64 >= q * 1000.0
}

pub fn play(script: Script, policy: &Policy) -> Outcome {
    let mut engine = Engine::new(policy.opts, 0, script.unknowns);
    let mut is_time = vec![false; script.unknowns];
    for t in &script.times {
        is_time[*t] = true;
    }
    let comparisons = script.steps.iter().filter(|s| matches!(s, Step::Decide { .. })).count();
    let mut open = Vec::with_capacity(comparisons);
    let mut sites = Vec::with_capacity(comparisons);
    let mut last_time: Option<usize> = None;
    let mut steps = script.steps.into_iter().peekable();
    while let Some(step) = steps.next() {
        if let Some(deadline) = policy.deadline {
            if engine.state() == State::Solving && Instant::now() >= deadline {
                engine.concede(Cause::Cap);
            }
        }
        match step {
            Step::Unknown(index, like) => {
                let made = if is_time[index] {
                    // The row that orders it comes next; the time before it
                    // may die right after that row.
                    let floor = steps.next();
                    debug_assert!(matches!(floor, Some(Step::Require(_))));
                    let ends = matches!(steps.peek(), Some(Step::Dead(u)) if Some(*u) == last_time);
                    if ends {
                        steps.next();
                    }
                    let made = engine.time(ends);
                    last_time = Some(made);
                    made
                } else if script.lasting.contains(&index) {
                    engine.duration()
                } else {
                    engine.unknown(like)
                };
                assert_eq!(made, index, "the engine numbers unknowns as the script does");
            }
            Step::Require(rows) => {
                engine.require(rows);
            }
            Step::Dead(unknown) => engine.forget(unknown),
            // Recorded runs carry no horizon; the engine's options give it.
            Step::Horizon(..) => {}
            Step::Decide { taken, other, site, outcome } => {
                let ask = match policy.draw {
                    Some(q) if draws_witnessed(open.len(), site, q) => Ask::UnlessWitnessed,
                    _ => Ask::Always,
                };
                open.push(engine.decide(site, outcome, taken, other, ask));
                sites.push((site, outcome));
            }
            Step::Lasting(_) | Step::Glue { .. } => unreachable!("scripts do not carry these"),
        }
    }
    // The run's rows are all accepted by now; a finish needs no log.
    let log = engine.take_log();
    Outcome { open, sites, report: engine.finish(), _log: log }
}

/// The script with every constant multiplied by `by`: the same system with
/// every unknown's value scaled by `by`.
pub fn scaled(mut script: Script, by: spur_time::Q) -> Script {
    let scale_rows = |rows: &mut Vec<spur_time::Row>| rows.iter_mut().for_each(|r| r.constant *= by);
    for step in &mut script.steps {
        match step {
            Step::Require(rows) => scale_rows(rows),
            Step::Decide { taken, other, .. } => {
                scale_rows(taken);
                other.iter_mut().for_each(|c| scale_rows(c));
            }
            _ => {}
        }
    }
    script
}
