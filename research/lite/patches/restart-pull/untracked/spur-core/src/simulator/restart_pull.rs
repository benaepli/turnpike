//! A restart pulls every still-held planned crash of another node into a
//! learned window after the restart.
//!
//! A placed crash draws its target step on a clock that knows nothing about
//! the other nodes' restarts, so a crash landing in the stretch after a
//! peer's restart - where records from the peer's dead incarnation reach
//! the live nodes and those nodes react - is reached by chance. On a salted
//! half of the placed runs, a restart of node p at step s re-targets every
//! other node's pending crash whose target lies past s + S to a step in
//! [s, s + S]. The new target is the old target reduced modulo S + 1, so
//! the offset reuses the randomness already drawn: nothing is drawn, and
//! the untreated half keeps every random stream in step with the treated
//! one. A pull only ever shortens a hold.
//!
//! S is the ghost lag learned per backup-budget scope: at every message
//! entry whose origin restarted since sending, at a live destination other
//! than the origin, the lag is the entry step less the origin's last restart
//! step. Only run-cap probes feed the learner, which are never placed; the
//! window is the 0.9 quantile read at the winning cell's upper edge once a
//! scope holds enough samples, recomputed at doubling checkpoints. Below
//! the floor no pull happens.
//!
//! Half of the pulling runs, under a salt of their own, release a pulled
//! crash by a trigger instead of an offset: the pulled target becomes s + S
//! and the first message entry after s at a live node other than p, from
//! p's dead incarnation, that changes that node's state moves every pulled
//! crash to the next step. Without such an entry by s + S the crash goes at
//! s + S. Nothing is drawn on that half either.

use crate::simulator::core::state::SendLedger;
use crate::simulator::fault_timing;
use crate::simulator::run_cap;
use crate::simulator::run_phase;
use crate::simulator::util_stats::{self, RestartPullCell};
use dashmap::DashMap;
use std::sync::LazyLock;

/// Salt for the half of the placed runs that pull. Distinct from every
/// other split of a session.
const PULL_SALT: u64 = 0x_5253_5452_5055_4C4C; // "RSTRPULL"

/// Salt for the half of the pulling runs that release by the trigger.
const TRIGGER_SALT: u64 = 0x_4748_4F53_5454_5247; // "GHOSTTRG"

/// Quantile of the lag distribution the window is read from.
const QUANTILE: f64 = 0.9;

/// Lag samples a scope must accumulate before its window takes effect.
const MIN_SAMPLES: u64 = 200;

/// Histogram cells per scope. A lag is a count of steps between a restart
/// and an entry from the restarted node's dead incarnation, so a cell is one
/// step wide and the last cell takes every lag past the range.
const HIST_CELLS: usize = 256;

/// The coin that puts a placed run in the pulling half.
fn pull_coin(run_id: i64) -> bool {
    run_phase::salted_phase(run_id, PULL_SALT, 2) == 1
}

/// The coin that puts a pulling run in the triggering half.
fn trigger_coin(run_id: i64) -> bool {
    run_phase::salted_phase(run_id, TRIGGER_SALT, 2) == 1
}

/// Whether this run's restarts pull the other nodes' held crashes, read
/// from the run id's placement coin. Drawn over the placed runs, so
/// run-cap probes are exempt.
pub fn is_treated(run_id: i64) -> bool {
    fault_timing::is_placed(run_id) && pull_coin(run_id)
}

/// Whether this run releases a pulled crash by the trigger, read from the
/// run id's placement coin. Never set without `is_treated`.
pub fn is_triggered(run_id: i64) -> bool {
    is_treated(run_id) && trigger_coin(run_id)
}

/// The cell a run occupies given whether it is placed - by its crash arm,
/// which a learner may have chosen over the id's coin - and its own coins:
/// the pulling halves, the placed runs that do not pull, or outside the
/// placed posture. A run that draws no holds has nothing a restart could
/// pull, so it is outside the cells whatever its coins say.
pub fn cell_of(placed: bool, run_id: i64) -> RestartPullCell {
    if !placed {
        RestartPullCell::Unplaced
    } else if !pull_coin(run_id) {
        RestartPullCell::Untreated
    } else if trigger_coin(run_id) {
        RestartPullCell::Trigger
    } else {
        RestartPullCell::PullOnly
    }
}

/// `cell_of` with placement read from the run id's coin.
pub fn cell(run_id: i64) -> RestartPullCell {
    cell_of(fault_timing::is_placed(run_id), run_id)
}

/// Whether this run's ghost lags may feed the learner: run-cap probes only,
/// which are in the stock posture at every placement fraction.
pub fn feeds_learner(run_id: i64) -> bool {
    run_cap::is_probe(run_id)
}

struct ScopeAccum {
    /// Cell `c` counts the lags equal to `c`, the last cell those at or past
    /// it.
    hist: [u32; HIST_CELLS],
    /// Lags folded into the histogram.
    samples: u64,
    /// The window set at the last checkpoint, governing every run until the
    /// next one; None until the first checkpoint is crossed.
    current: Option<i32>,
    /// Sample count at which the window is next recomputed; doubles after
    /// each recompute.
    next_checkpoint: u64,
}

impl ScopeAccum {
    fn new() -> Self {
        Self {
            hist: [0; HIST_CELLS],
            samples: 0,
            current: None,
            next_checkpoint: MIN_SAMPLES,
        }
    }

    /// The window the histogram supports right now, or None while it is
    /// below the sample floor. Laplace-smoothed and read at the winning
    /// cell's upper edge, so bucketing only ever rounds the window up.
    fn estimate(&self, backup: i32) -> Option<i32> {
        if self.samples < MIN_SAMPLES {
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
            if (cum + 1) as f64 / denom >= QUANTILE {
                return Some((c as i64).min(backup as i64) as i32);
            }
        }
        None
    }
}

static TABLE: LazyLock<DashMap<i32, ScopeAccum>> = LazyLock::new(DashMap::new);

/// The learned window for a scope, or None while the scope is below its
/// sample floor. Constant between checkpoints.
pub fn lag_quantile(backup: i32) -> Option<i32> {
    TABLE.get(&backup).and_then(|acc| acc.current)
}

/// Fold one ghost lag from a run that feeds the learner into its scope.
pub fn merge_probe_lag(backup: i32, lag: i32) {
    util_stats::record_restart_pull_lag_sample();
    let mut acc = TABLE.entry(backup).or_insert_with(ScopeAccum::new);
    let cell = (lag.max(0) as usize).min(HIST_CELLS - 1);
    acc.hist[cell] = acc.hist[cell].saturating_add(1);
    acc.samples += 1;
    if acc.samples >= acc.next_checkpoint {
        acc.current = acc.estimate(backup);
        acc.next_checkpoint = acc.next_checkpoint.saturating_mul(2);
        drop(acc);
        publish_gauges();
    }
}

/// Scale every scope's mass by `factor`, dropping scopes that reach zero,
/// so stale phases of a long exploration lose their vote. The window and
/// the next checkpoint are left alone: shrinking the sample count delays
/// the next crossing, and the recompute there reads the decay-weighted
/// histogram.
pub fn decay(factor: f64) {
    let factor = factor.clamp(0.0, 1.0);
    TABLE.retain(|_, acc| {
        for n in acc.hist.iter_mut() {
            *n = ((*n as f64) * factor).floor() as u32;
        }
        acc.samples = ((acc.samples as f64) * factor).floor() as u64;
        acc.current.is_some() || acc.samples > 0 || acc.hist.iter().any(|&n| n > 0)
    });
    publish_gauges();
}

/// Clear the table so explorer sessions in one process do not share
/// windows.
pub fn reset() {
    TABLE.clear();
    util_stats::set_restart_pull_learned(0, 0);
}

fn publish_gauges() {
    let mut engaged: u64 = 0;
    let mut max_scope: Option<(i32, i32)> = None;
    for e in TABLE.iter() {
        let backup = *e.key();
        if let Some(window) = e.value().current {
            engaged += 1;
            if max_scope.is_none_or(|(k, _)| backup > k) {
                max_scope = Some((backup, window));
            }
        }
    }
    util_stats::set_restart_pull_learned(engaged, max_scope.map_or(0, |(_, w)| w.max(0) as u64));
}

/// The trigger armed by a restart on the triggering half: the restarted
/// node, the step it restarted at, and the step the pulled crashes go at
/// if no entry fires it first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Trigger {
    pub origin: usize,
    pub restart_step: i32,
    pub expires: i32,
}

/// One run's pull state. `pulled_mask` has a bit per node, up to the first
/// 64, whose pending crash was pulled and is still waiting; `fired_mask`
/// the pulled crashes the trigger has released and that have not yet been
/// applied, with `ghost_node` the node whose entry fired the trigger last.
#[derive(Clone, Debug, Default)]
pub struct RunState {
    pub cell: RestartPullCell,
    /// The scope's learned window at run start, or None below the floor.
    pub window: Option<i32>,
    /// The run is a run-cap probe, so its ghost lags feed the learner.
    pub feeds_learner: bool,
    /// The backup-budget scope the run's lags are folded into.
    pub scope: i32,
    pub pulled_mask: u64,
    pub trigger: Option<Trigger>,
    pub fired_mask: u64,
    pub ghost_node: Option<usize>,
    /// Crashes applied in this run so far.
    pub crashes_applied: u32,
}

impl RunState {
    /// The state a run starts with: its cell given whether its crash arm
    /// draws holds, the window its scope has learned by now, and whether
    /// it feeds the learner.
    pub fn at_run_start(run_id: i64, backup: i32, placed: bool) -> Self {
        Self {
            cell: cell_of(placed, run_id),
            window: lag_quantile(backup),
            feeds_learner: feeds_learner(run_id),
            scope: backup,
            ..Self::default()
        }
    }

    /// Whether restarts on this run pull held crashes.
    pub fn pulls(&self) -> bool {
        matches!(
            self.cell,
            RestartPullCell::PullOnly | RestartPullCell::Trigger
        )
    }

    /// Whether a pulled crash on this run is released by the trigger.
    pub fn triggers(&self) -> bool {
        self.cell == RestartPullCell::Trigger
    }
}

/// What one restart did to the other nodes' holds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Pull {
    /// Some other node had a pending crash whose target was still ahead.
    pub held_crash: bool,
    pub pulls: u64,
    pub steps_saved: u64,
    /// The nodes whose holds were pulled.
    pub mask: u64,
}

/// The target a hold at `old_target` takes after a restart at
/// `restart_step` with window `window`, or None when the hold is not pulled
/// because its target is already within the window. With `to_window_end`
/// the pulled target is the window's end, else the old target reduced
/// modulo `window + 1` past the restart. Never later than the old target.
pub fn pulled_target(
    old_target: i32,
    restart_step: i32,
    window: i32,
    to_window_end: bool,
) -> Option<i32> {
    let end = restart_step.saturating_add(window);
    if old_target <= end {
        return None;
    }
    Some(if to_window_end {
        end
    } else {
        restart_step + old_target.rem_euclid(window.saturating_add(1))
    })
}

/// Apply one restart of `origin` at `restart_step` to the holds: every
/// other node with a pending crash whose target lies past the window is
/// re-targeted. Nodes past the mask width keep their holds.
pub fn pull_holds(
    hold_until: &mut [i32],
    ledgers: &[SendLedger],
    origin: usize,
    restart_step: i32,
    window: i32,
    to_window_end: bool,
) -> Pull {
    let mut out = Pull::default();
    let width = hold_until.len().min(u64::BITS as usize);
    for n in 0..width {
        if n == origin || ledgers.get(n).is_none_or(|l| l.crash_pending == 0) {
            continue;
        }
        let old = hold_until[n];
        if old > restart_step {
            out.held_crash = true;
        }
        if let Some(target) = pulled_target(old, restart_step, window, to_window_end) {
            hold_until[n] = target;
            out.pulls += 1;
            out.steps_saved += (old - target).max(0) as u64;
            out.mask |= 1u64 << n;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::simulator::config_override;

    fn feed(n: usize, backup: i32, lag: i32) {
        for _ in 0..n {
            merge_probe_lag(backup, lag);
        }
    }

    #[test]
    fn the_pulling_half_is_half_the_placed_runs_and_the_trigger_half_of_that() {
        let _serial = config_override::exclusive_session();
        fault_timing::reset();
        let n = 64_000i64;
        let placed = (0..n).filter(|&id| fault_timing::is_placed(id)).count();
        let treated = (0..n).filter(|&id| is_treated(id)).count();
        let triggered = (0..n).filter(|&id| is_triggered(id)).count();
        let share = treated as f64 / placed as f64;
        assert!(
            (share - 0.5).abs() < 0.02,
            "the pulling share of placed runs is {share}"
        );
        let nested = triggered as f64 / treated as f64;
        assert!(
            (nested - 0.5).abs() < 0.02,
            "the trigger share of pulling runs is {nested}"
        );
        assert_eq!(
            (0..n)
                .filter(|&id| is_treated(id) && !fault_timing::is_placed(id))
                .count(),
            0,
            "an unplaced run must never pull"
        );
        assert_eq!(
            (0..n)
                .filter(|&id| is_treated(id) && run_cap::is_probe(id))
                .count(),
            0,
            "a run-cap probe must never pull"
        );
        assert_eq!(
            (0..n)
                .filter(|&id| is_triggered(id) && !is_treated(id))
                .count(),
            0,
            "the trigger half lies inside the pulling half"
        );
        // Neither split may follow another split of the same session.
        let with_anchor = (0..n)
            .filter(|&id| fault_timing::is_placed(id))
            .filter(|&id| is_treated(id) == crate::simulator::crash_phase::is_anchored(id))
            .count();
        let overlap = with_anchor as f64 / placed as f64;
        assert!(
            (overlap - 0.5).abs() < 0.03,
            "pulling follows the anchor split at {overlap}"
        );
        let with_pull = (0..n)
            .filter(|&id| is_treated(id))
            .filter(|&id| is_triggered(id) == (run_phase::phase(id, 2) == 1))
            .count();
        let overlap = with_pull as f64 / treated as f64;
        assert!(
            (overlap - 0.5).abs() < 0.03,
            "the trigger follows the plain phase at {overlap}"
        );
        for id in 0..n {
            let c = cell(id);
            assert_eq!(c == RestartPullCell::Trigger, is_triggered(id), "run {id}");
            assert_eq!(
                c == RestartPullCell::PullOnly,
                is_treated(id) && !is_triggered(id)
            );
            assert_eq!(
                c == RestartPullCell::Untreated,
                fault_timing::is_placed(id) && !is_treated(id)
            );
            assert_eq!(c == RestartPullCell::Unplaced, !fault_timing::is_placed(id));
            assert_eq!(feeds_learner(id), run_cap::is_probe(id));
        }
    }

    #[test]
    fn the_window_is_the_upper_cell_edge_at_the_quantile_and_constant_between_checkpoints() {
        let _serial = config_override::exclusive_session();
        reset();
        feed(199, 6000, 12);
        assert_eq!(lag_quantile(6000), None, "199 samples are under the floor");
        feed(1, 6000, 12);
        assert_eq!(lag_quantile(6000), Some(12));
        // Between checkpoints the window does not move.
        feed(150, 6000, 40);
        assert_eq!(
            lag_quantile(6000),
            Some(12),
            "350 samples sit between checkpoints"
        );
        // At 400 the recompute reads the mixture: 200 at 12 and 200 at
        // 40, whose 0.9 quantile is the 40 cell.
        feed(50, 6000, 40);
        assert_eq!(lag_quantile(6000), Some(40));
        assert_eq!(lag_quantile(1500), None, "another scope stays unengaged");
        // Nine in ten at 5 and one in ten at 30: the smoothed 0.9 quantile
        // still reaches the 30 cell only once its mass passes the line.
        reset();
        feed(180, 6000, 5);
        feed(20, 6000, 30);
        assert_eq!(lag_quantile(6000), Some(30));
        reset();
        feed(190, 6000, 5);
        feed(10, 6000, 30);
        assert_eq!(lag_quantile(6000), Some(5));
        reset();
    }

    #[test]
    fn a_lag_past_the_range_lands_in_the_last_cell_and_the_window_is_bounded_by_the_budget() {
        let _serial = config_override::exclusive_session();
        reset();
        feed(200, 6000, 5_000);
        assert_eq!(lag_quantile(6000), Some(HIST_CELLS as i32 - 1));
        reset();
        feed(200, 100, 5_000);
        assert_eq!(
            lag_quantile(100),
            Some(100),
            "the window never exceeds the scope's budget"
        );
        reset();
    }

    #[test]
    fn decay_delays_the_next_checkpoint_and_reset_empties() {
        let _serial = config_override::exclusive_session();
        reset();
        feed(200, 6000, 12);
        assert_eq!(lag_quantile(6000), Some(12));
        decay(0.5);
        assert_eq!(
            lag_quantile(6000),
            Some(12),
            "the window survives decay unchanged"
        );
        feed(300, 6000, 40);
        assert_eq!(
            lag_quantile(6000),
            Some(40),
            "the delayed recompute follows fresher lags"
        );
        reset();
        assert_eq!(lag_quantile(6000), None);
    }

    #[test]
    fn the_gauges_follow_the_engaged_scopes() {
        let _serial = config_override::exclusive_session();
        reset();
        let zero = util_stats::snapshot().crash_place.restart_pull;
        assert_eq!((zero.scopes_engaged, zero.lag_p90), (0, 0));
        feed(200, 1500, 8);
        feed(200, 6000, 21);
        let s = util_stats::snapshot().crash_place.restart_pull;
        assert_eq!(
            (s.scopes_engaged, s.lag_p90),
            (2, 21),
            "the gauge reads the widest scope"
        );
        reset();
        let z = util_stats::snapshot().crash_place.restart_pull;
        assert_eq!((z.scopes_engaged, z.lag_p90), (0, 0));
    }

    #[test]
    fn a_run_below_the_floor_starts_with_no_window_and_the_cells_are_the_ids() {
        let _serial = config_override::exclusive_session();
        fault_timing::reset();
        reset();
        let treated = (0..100_000i64).find(|&id| is_treated(id)).unwrap();
        let s = RunState::at_run_start(treated, 6000, true);
        assert_eq!(s.window, None);
        assert!(s.pulls());
        assert_eq!(s.cell, cell(treated));
        assert_eq!(s.scope, 6000);
        assert!(!s.feeds_learner);
        // A crash arm that draws no holds leaves the run outside the cells
        // whatever its coins say.
        let stock_arm = RunState::at_run_start(treated, 6000, false);
        assert_eq!(stock_arm.cell, RestartPullCell::Unplaced);
        assert!(!stock_arm.pulls());
        feed(200, 6000, 9);
        let s = RunState::at_run_start(treated, 6000, true);
        assert_eq!(s.window, Some(9));
        let probe = (0..100_000i64).find(|&id| run_cap::is_probe(id)).unwrap();
        let p = RunState::at_run_start(probe, 6000, false);
        assert!(p.feeds_learner && !p.pulls() && !p.triggers());
        assert_eq!(p.cell, RestartPullCell::Unplaced);
        let unplaced_coin = (0..100_000i64)
            .find(|&id| !fault_timing::is_placed(id) && !run_cap::is_probe(id))
            .unwrap();
        assert_eq!(cell(unplaced_coin), RestartPullCell::Unplaced);
        assert_ne!(
            cell_of(true, unplaced_coin),
            RestartPullCell::Unplaced,
            "a learner-placed run takes the cell its coins name"
        );
        reset();
    }

    #[test]
    fn a_pulled_target_lands_inside_the_window_and_never_later_than_the_old_one() {
        let s = 100;
        let w = 20;
        assert_eq!(
            pulled_target(s + w, s, w, false),
            None,
            "a target at the window's end stays"
        );
        assert_eq!(
            pulled_target(s + 5, s, w, false),
            None,
            "a target inside the window stays"
        );
        assert_eq!(
            pulled_target(s - 3, s, w, false),
            None,
            "a target before the restart stays"
        );
        for old in s + w + 1..s + 400 {
            let t = pulled_target(old, s, w, false).expect("past the window is pulled");
            assert!((s..=s + w).contains(&t), "old {old} pulled to {t}");
            assert_eq!(t, s + old % (w + 1));
            assert!(t < old);
            assert_eq!(pulled_target(old, s, w, true), Some(s + w));
        }
        assert_eq!(
            pulled_target(7, 3, 0, false),
            Some(3),
            "a zero window pulls to the restart"
        );
    }

    #[test]
    fn a_restart_pulls_only_the_other_nodes_held_crashes_past_the_window() {
        let mut ledgers = [SendLedger::default(); 5];
        ledgers[1].crash_pending = 1;
        ledgers[2].crash_pending = 1;
        ledgers[3].crash_pending = 1;
        ledgers[0].crash_pending = 1;
        // Node 4 has a far target but no queued crash; node 0 is the
        // restarted node itself; node 3 is already inside the window.
        let mut holds = [900, 500, 431, 110, 800];
        let p = pull_holds(&mut holds, &ledgers, 0, 100, 20, false);
        assert_eq!(holds, [900, 100 + 500 % 21, 100 + 431 % 21, 110, 800]);
        assert!(p.held_crash);
        assert_eq!(p.pulls, 2);
        assert_eq!(p.mask, 0b110);
        assert_eq!(
            p.steps_saved,
            (500 - holds[1]) as u64 + (431 - holds[2]) as u64
        );

        let mut holds = [0, 100, 120, 0, 0];
        let p = pull_holds(&mut holds, &ledgers, 0, 100, 20, false);
        assert_eq!(
            p,
            Pull {
                held_crash: true,
                ..Pull::default()
            }
        );
        assert_eq!(
            holds,
            [0, 100, 120, 0, 0],
            "nothing inside the window is touched"
        );

        let mut holds = [0, 90, 0, 0, 0];
        let p = pull_holds(&mut holds, &ledgers, 0, 100, 20, false);
        assert!(!p.held_crash, "a target already passed is not a held crash");

        let mut holds = [900, 500, 431, 110, 800];
        let p = pull_holds(&mut holds, &ledgers, 0, 100, 20, true);
        assert_eq!(
            holds,
            [900, 120, 120, 110, 800],
            "the trigger half pulls to the window's end"
        );
        assert_eq!(p.pulls, 2);
    }
}
