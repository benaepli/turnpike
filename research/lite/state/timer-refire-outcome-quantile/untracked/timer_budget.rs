//! Refire budgets for timer classes, learned across runs and shared by every
//! worker in a session. A timer class is the vertex the woken reader resumes
//! at. Each completed run contributes one sample per (node, class): how many
//! times that class fired on that node. The budget for a class is a high
//! quantile of those samples, so a timer that has already fired more often
//! this run than completed runs exhibit gets its selection score damped.

use crate::compiler::cfg::Vertex;
use crate::simulator::util_stats;
use dashmap::DashMap;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

/// Multiplier applied to the selection score of a timer whose per-run firing
/// count has reached its class budget. Bounded above zero so an over-budget
/// timer stays reachable.
pub const REFIRE_DAMP: f64 = 0.25;

/// Firings a class must accumulate, summed over nodes and all run outcomes,
/// before its budget takes effect. Below the floor the class scores as if
/// this table did not exist.
pub const MIN_CLASS_FIRINGS: u64 = 200;

/// Quantile of the completed-run firing-count distribution read as the
/// budget.
pub const BUDGET_QUANTILE: f64 = 0.90;

/// Histogram cells per class. A per-run count at or above the last cell
/// saturates into it; a budget that lands in the saturated cell is treated
/// as unbounded and the class is never damped.
const HIST_CELLS: usize = 256;

/// How a run ended, as this table accounts for it. Only completed runs
/// contribute distribution samples; only exhausted runs feed the exhausted
/// split; deadlocked runs count toward the sample floor alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Completed,
    Exhausted,
    Deadlocked,
}

struct ClassAccum {
    /// Cell `c` counts the completed-run (node, class) samples whose firing
    /// count was `c`, saturating into the last cell.
    hist: [u32; HIST_CELLS],
    /// Firings of this class summed over nodes and all run outcomes.
    total_firings: u64,
    /// The subset of `total_firings` from runs that exhausted their
    /// iteration budget.
    exhausted_firings: u64,
}

impl ClassAccum {
    fn new() -> Self {
        Self {
            hist: [0; HIST_CELLS],
            total_firings: 0,
            exhausted_firings: 0,
        }
    }

    /// The smallest count `c` such that the Laplace-smoothed share of
    /// completed-run samples at or below `c` reaches the quantile, or None
    /// while the class is below the firing floor, has no completed samples,
    /// or the quantile lands in the saturated cell.
    fn budget(&self) -> Option<u32> {
        if self.total_firings < MIN_CLASS_FIRINGS {
            return None;
        }
        let samples: u64 = self.hist.iter().map(|&n| n as u64).sum();
        if samples == 0 {
            return None;
        }
        let denom = (samples + 2) as f64;
        let mut cum: u64 = 0;
        for (c, &n) in self.hist.iter().enumerate() {
            cum += n as u64;
            if (cum + 1) as f64 / denom >= BUDGET_QUANTILE {
                if c == HIST_CELLS - 1 {
                    return None;
                }
                return Some(c as u32);
            }
        }
        None
    }
}

static TABLE: LazyLock<DashMap<Vertex, ClassAccum>> = LazyLock::new(DashMap::new);

/// Budgets frozen for one run: a class is present only when it has earned a
/// budget, so lookups double as the identity check. Taken once at run start
/// so scores are stable within the run and the hot path takes no locks.
#[derive(Debug, Default)]
pub struct TimerBudgetSnap {
    budgets: HashMap<Vertex, u32>,
}

impl TimerBudgetSnap {
    pub fn is_empty(&self) -> bool {
        self.budgets.is_empty()
    }

    pub fn budget(&self, vertex: Vertex) -> Option<u32> {
        self.budgets.get(&vertex).copied()
    }
}

/// Fold one run's per-(node, class) firing counts into the table.
pub fn merge_run(outcome: Outcome, firings: &[(usize, Vertex, u32)]) {
    for &(_node, vertex, count) in firings {
        let mut acc = TABLE.entry(vertex).or_insert_with(ClassAccum::new);
        acc.total_firings += count as u64;
        match outcome {
            Outcome::Completed => {
                let cell = (count as usize).min(HIST_CELLS - 1);
                acc.hist[cell] = acc.hist[cell].saturating_add(1);
            }
            Outcome::Exhausted => acc.exhausted_firings += count as u64,
            Outcome::Deadlocked => {}
        }
    }
    util_stats::set_refire_classes_learned(learned_classes());
}

/// Budgets for every class currently past the floor.
pub fn snapshot() -> Arc<TimerBudgetSnap> {
    let budgets: HashMap<Vertex, u32> = TABLE
        .iter()
        .filter_map(|e| e.value().budget().map(|b| (*e.key(), b)))
        .collect();
    Arc::new(TimerBudgetSnap { budgets })
}

/// Scale every class's mass by `factor`, dropping classes that reach zero,
/// so stale sessions of a long exploration lose their vote.
pub fn decay(factor: f64) {
    let factor = factor.clamp(0.0, 1.0);
    TABLE.retain(|_, acc| {
        for n in acc.hist.iter_mut() {
            *n = ((*n as f64) * factor).floor() as u32;
        }
        acc.total_firings = ((acc.total_firings as f64) * factor).floor() as u64;
        acc.exhausted_firings = ((acc.exhausted_firings as f64) * factor).floor() as u64;
        acc.total_firings > 0 || acc.hist.iter().any(|&n| n > 0)
    });
    util_stats::set_refire_classes_learned(learned_classes());
}

/// Clear the table so explorer sessions in one process do not share budgets.
pub fn reset() {
    TABLE.clear();
    util_stats::set_refire_classes_learned(0);
}

fn learned_classes() -> u64 {
    TABLE.iter().filter(|e| e.value().budget().is_some()).count() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::simulator::config_override;

    const V: Vertex = 7;

    #[test]
    fn no_budget_below_the_firing_floor() {
        let _serial = config_override::exclusive_session();
        reset();
        for _ in 0..100 {
            merge_run(Outcome::Completed, &[(0, V, 1)]);
        }
        assert_eq!(snapshot().budget(V), None, "100 firings are under the floor");
        assert!(snapshot().is_empty());
    }

    #[test]
    fn budget_is_the_smoothed_quantile_of_completed_counts() {
        let _serial = config_override::exclusive_session();
        reset();
        for _ in 0..95 {
            merge_run(Outcome::Completed, &[(0, V, 3)]);
        }
        for _ in 0..5 {
            merge_run(Outcome::Completed, &[(0, V, 10)]);
        }
        // 100 samples: cumulative 95 at count 3; (95 + 1) / (100 + 2) >= 0.9,
        // and no smaller count reaches it.
        assert_eq!(snapshot().budget(V), Some(3));
        assert_eq!(snapshot().budget(V + 1), None, "unseen classes stay identity");
    }

    #[test]
    fn exhausted_runs_alone_never_create_a_budget() {
        let _serial = config_override::exclusive_session();
        reset();
        for _ in 0..100 {
            merge_run(Outcome::Exhausted, &[(0, V, 50)]);
        }
        assert_eq!(snapshot().budget(V), None);
    }

    #[test]
    fn deadlocked_runs_feed_the_floor_but_not_the_distribution() {
        let _serial = config_override::exclusive_session();
        reset();
        for _ in 0..20 {
            merge_run(Outcome::Completed, &[(0, V, 2)]);
        }
        assert_eq!(snapshot().budget(V), None, "40 firings are under the floor");
        merge_run(Outcome::Deadlocked, &[(0, V, 160)]);
        assert_eq!(snapshot().budget(V), Some(2));
    }

    #[test]
    fn capped_out_classes_are_omitted_rather_than_damped() {
        let _serial = config_override::exclusive_session();
        reset();
        for _ in 0..100 {
            merge_run(Outcome::Completed, &[(0, V, 300)]);
        }
        assert_eq!(snapshot().budget(V), None);
    }

    #[test]
    fn decay_shrinks_mass_back_to_identity_and_reset_empties() {
        let _serial = config_override::exclusive_session();
        reset();
        for _ in 0..100 {
            merge_run(Outcome::Completed, &[(0, V, 3)]);
        }
        assert_eq!(snapshot().budget(V), Some(3));
        decay(0.5);
        assert_eq!(snapshot().budget(V), None, "150 firings fall under the floor");
        for _ in 0..20 {
            decay(0.5);
        }
        assert!(TABLE.is_empty(), "repeated decay drops the class");

        for _ in 0..100 {
            merge_run(Outcome::Completed, &[(0, V, 3)]);
        }
        assert!(!snapshot().is_empty());
        reset();
        assert!(TABLE.is_empty());
        assert!(snapshot().is_empty());
    }
}
