//! A learned stop for runs whose fault plan has finished, shared across a
//! session. Once every planned crash, recover, partition and heal has been
//! applied, the traffic a run still has to show is the settling of messages
//! that cross a fault: deliveries whose sender was down, or restarted since
//! sending. How long that settling takes after the last recover is learned
//! from run-cap probes, which run to the full budget: the settle of a probe
//! is the step of its last fault-crossing message entry minus the step of
//! its last recover. A treated run then ends once it has applied its whole
//! fault plan, has taken at least one crossing entry after its last recover,
//! and stands at least the learned settle past that recover.
//!
//! The settle is a high quantile of the probe settles with headroom, kept
//! per scope, where a scope is the run's step budget together with the
//! campaign arm that issued it (-1 for a session without arms). It is
//! recomputed only when a scope's keyed count crosses a doubling checkpoint
//! (200, 400, 800, ...) and is constant in between. A scope under its floor
//! is identity: the run falls back to the existing step cap.
//!
//! Treatment covers one half of the runs that are neither run-cap probes nor
//! timer-context probes, drawn by run id under a salt of this module's own,
//! so no learner's feed changes and the untreated half is what it was.

use crate::simulator::run_cap;
use crate::simulator::run_phase;
use crate::simulator::timer_context;
use crate::simulator::util_stats;
use dashmap::DashMap;
use std::sync::LazyLock;

/// Quantile of the probe settle distribution the stop is read from.
const QUANTILE: f64 = 0.99;

/// Multiplier applied to the quantile so a run settling slightly slower
/// than the quantile still shows its last crossing entry before it ends.
const HEADROOM: f64 = 1.5;

/// Keyed probes a scope must accumulate before its settle takes effect.
/// Below the floor every run keeps the existing step cap.
const MIN_KEYED_SAMPLES: u64 = 200;

/// Histogram cells per scope. A settle is bounded by the budget, so the
/// cells are sized by a per-scope width that lets the full budget fit.
const HIST_CELLS: usize = 256;

/// Domain salt for the treated half. Distinct from every other split of the
/// session so the half is independent of each mechanism's own coin.
const STOP_SALT: u64 = 0x5345_5454_4c45_5354;

/// The runs treated: half of the runs that are neither kind of probe. A
/// run-cap probe runs uncapped to feed the cap learner and this one; a
/// timer-context probe feeds the timer learner unsteered; neither may be
/// cut short, or a learner would read truncated samples.
pub fn is_treated(run_id: i64) -> bool {
    !run_cap::is_probe(run_id)
        && timer_context::run_mode(run_id) != timer_context::RunMode::Probe
        && run_phase::salted_phase(run_id, STOP_SALT, 2) == 0
}

/// The step at which a run may end under the rule, given the settle its
/// scope holds and where the run stands: the last recover plus the settle,
/// once the run has applied a recover and taken a fault-crossing entry
/// after it. None while any of those is missing, so a run without a key
/// runs to its cap. The caller also requires every fault plan event to be
/// completed.
pub fn stop_step(
    settle: Option<i32>,
    last_recover_step: Option<i32>,
    last_crossing_step: Option<i32>,
) -> Option<i32> {
    let settle = settle?;
    let recover = last_recover_step?;
    let crossing = last_crossing_step?;
    if crossing <= recover {
        return None;
    }
    Some(recover.saturating_add(settle))
}

/// What one probe run showed, read at its end whatever its outcome.
/// `response_steps` are the steps of every client response in the run, in
/// order; only those after the last recover are read.
pub struct ProbeRun<'a> {
    pub last_recover_step: Option<i32>,
    pub last_crossing_step: Option<i32>,
    /// The step the plan completed at, when it did.
    pub completed_at: Option<i32>,
    pub response_steps: &'a [i32],
}

struct ScopeAccum {
    /// Steps per histogram cell, fixed when the scope is created.
    bucket_width: u32,
    /// Cell `c` counts the keyed probes whose settle fell in
    /// `[c * bucket_width, (c + 1) * bucket_width)`.
    hist: [u32; HIST_CELLS],
    /// Keyed probes folded into the histogram.
    keyed: u64,
    /// The settle set at the last checkpoint, governing every run until the
    /// next one; None until the first checkpoint is crossed.
    current: Option<i32>,
    /// Keyed count at which the settle is next recomputed; doubles after
    /// each recompute.
    next_checkpoint: u64,
}

impl ScopeAccum {
    fn new(backup: i32) -> Self {
        Self {
            bucket_width: ((backup.max(1) + HIST_CELLS as i32 - 1) / HIST_CELLS as i32).max(1)
                as u32,
            hist: [0; HIST_CELLS],
            keyed: 0,
            current: None,
            next_checkpoint: MIN_KEYED_SAMPLES,
        }
    }

    /// The settle the histogram supports right now, or None while it is
    /// below the sample floor. The quantile is Laplace-smoothed and read at
    /// the winning cell's upper edge, so bucketing only ever rounds up.
    fn estimate(&self, backup: i32) -> Option<i32> {
        if self.keyed < MIN_KEYED_SAMPLES {
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
                let upper = (c as i64 + 1) * self.bucket_width as i64 - 1;
                let settled = (HEADROOM * upper as f64).ceil() as i64;
                return Some(settled.min(backup as i64) as i32);
            }
        }
        None
    }
}

/// Scopes are keyed by (step budget, campaign arm index).
static TABLE: LazyLock<DashMap<(i32, i32), ScopeAccum>> = LazyLock::new(DashMap::new);

/// The settle governing runs of budget `backup` issued by campaign arm
/// `arm_index`, or None while the scope is under its floor. Read once at
/// run start so the bound is frozen for the whole run.
pub fn settle(backup: i32, arm_index: i32) -> Option<i32> {
    TABLE.get(&(backup, arm_index)).and_then(|acc| acc.current)
}

/// Fold one run-cap probe into its scope. A probe that applied no recover
/// feeds nothing; one with a recover but no crossing entry after it is
/// counted and feeds nothing; a keyed probe folds its settle in. The plan
/// completion, when there was one, is checked against the settle in effect
/// before the probe merges, so a completion the stop would have cut is
/// visible. Client responses after the last recover feed the response-gap
/// histogram on every probe with a recover.
pub fn merge_probe(backup: i32, arm_index: i32, run: &ProbeRun) {
    let Some(recover) = run.last_recover_step else {
        util_stats::record_run_stop_probe_without_recover();
        return;
    };
    let mut prev = recover;
    let mut any_response = false;
    for &s in run.response_steps.iter().filter(|&&s| s > recover) {
        util_stats::record_run_stop_response_gap((s - prev).max(0) as u64);
        prev = s;
        any_response = true;
    }
    if any_response {
        util_stats::record_run_stop_probe_with_response();
    }
    let Some(crossing) = run.last_crossing_step.filter(|&c| c > recover) else {
        util_stats::record_run_stop_probe_without_key(recover.max(0) as u64);
        return;
    };
    let settled = crossing - recover;
    util_stats::record_run_stop_probe_keyed(recover.max(0) as u64, crossing.max(0) as u64);
    {
        let mut acc = TABLE
            .entry((backup, arm_index))
            .or_insert_with(|| ScopeAccum::new(backup));
        if let (Some(s), Some(done)) = (acc.current, run.completed_at)
            && done > recover.saturating_add(s)
        {
            util_stats::record_run_stop_probe_over_stop_completion();
        }
        let cell = ((settled.max(0) as u32) / acc.bucket_width).min(HIST_CELLS as u32 - 1);
        acc.hist[cell as usize] = acc.hist[cell as usize].saturating_add(1);
        acc.keyed += 1;
        if acc.keyed >= acc.next_checkpoint {
            acc.current = acc.estimate(backup);
            acc.next_checkpoint = acc.next_checkpoint.saturating_mul(2);
            util_stats::record_run_stop_recompute();
        }
    }
    publish_gauges();
}

/// Scale every scope's mass by `factor`, dropping scopes that reach zero,
/// so stale phases of a long exploration lose their vote. The settle and
/// the next checkpoint are left alone: shrinking the keyed count delays the
/// next crossing, and the recompute there reads the decay-weighted
/// histogram, so the settle leans toward recent phases.
pub fn decay(factor: f64) {
    let factor = factor.clamp(0.0, 1.0);
    TABLE.retain(|_, acc| {
        for n in acc.hist.iter_mut() {
            *n = ((*n as f64) * factor).floor() as u32;
        }
        acc.keyed = ((acc.keyed as f64) * factor).floor() as u64;
        acc.current.is_some() || acc.keyed > 0 || acc.hist.iter().any(|&n| n > 0)
    });
    publish_gauges();
}

/// Clear the table so explorer sessions in one process do not share
/// settles.
pub fn reset() {
    TABLE.clear();
    util_stats::set_run_stop_learned(0, 0, 0, 0);
}

fn publish_gauges() {
    let mut learned: u64 = 0;
    let mut max_scope: Option<((i32, i32), i32)> = None;
    let mut lo: Option<i32> = None;
    let mut hi: Option<i32> = None;
    for e in TABLE.iter() {
        let key = *e.key();
        if let Some(s) = e.value().current {
            learned += 1;
            if max_scope.is_none_or(|(k, _)| key > k) {
                max_scope = Some((key, s));
            }
            lo = Some(lo.map_or(s, |l| l.min(s)));
            hi = Some(hi.map_or(s, |h| h.max(s)));
        }
    }
    util_stats::set_run_stop_learned(
        learned,
        max_scope.map_or(0, |(_, s)| s.max(0) as u64),
        lo.map_or(0, |s| s.max(0) as u64),
        hi.map_or(0, |s| s.max(0) as u64),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::simulator::config_override;

    fn keyed(recover: i32, crossing: i32) -> ProbeRun<'static> {
        ProbeRun {
            last_recover_step: Some(recover),
            last_crossing_step: Some(crossing),
            completed_at: None,
            response_steps: &[],
        }
    }

    #[test]
    fn identity_below_the_floor_and_the_quantile_with_headroom_above_it() {
        let _serial = config_override::exclusive_session();
        reset();
        for _ in 0..199 {
            merge_probe(6000, -1, &keyed(300, 400));
        }
        assert_eq!(settle(6000, -1), None, "199 keyed probes are under the floor");
        merge_probe(6000, -1, &keyed(300, 400));
        // Width 24, so a settle of 100 lands in cell 4 with upper edge 119;
        // the settle is ceil(1.5 * 119).
        assert_eq!(settle(6000, -1), Some(179));
        assert_eq!(settle(6000, 0), None, "another arm's scope stays identity");
        assert_eq!(settle(1500, -1), None, "another budget's scope stays identity");
        reset();
        assert_eq!(settle(6000, -1), None, "reset empties the table");
    }

    #[test]
    fn probes_without_a_recover_or_without_a_crossing_after_it_fold_nothing() {
        let _serial = config_override::exclusive_session();
        util_stats::set_enabled(true);
        reset();
        let before = util_stats::snapshot().run_stop;
        for _ in 0..200 {
            merge_probe(
                6000,
                -1,
                &ProbeRun {
                    last_recover_step: None,
                    last_crossing_step: Some(50),
                    completed_at: Some(60),
                    response_steps: &[10, 20],
                },
            );
            merge_probe(6000, -1, &keyed(300, 300));
            merge_probe(6000, -1, &keyed(300, 250));
        }
        let after = util_stats::snapshot().run_stop;
        util_stats::set_enabled(false);
        assert_eq!(settle(6000, -1), None, "no keyed probe reached the floor");
        assert_eq!(after.probes_without_recover - before.probes_without_recover, 200);
        assert_eq!(after.probes_without_key - before.probes_without_key, 400);
        assert_eq!(after.probes_keyed - before.probes_keyed, 0);
        assert_eq!(after.last_recover_step_count - before.last_recover_step_count, 400);
        assert_eq!(after.last_crossing_step_count - before.last_crossing_step_count, 0);
        reset();
    }

    #[test]
    fn a_completion_past_the_engaged_settle_counts_and_still_folds_in() {
        let _serial = config_override::exclusive_session();
        util_stats::set_enabled(true);
        reset();
        for _ in 0..200 {
            merge_probe(6000, 2, &keyed(300, 400));
        }
        let s = settle(6000, 2).expect("the floor is crossed");
        let before = util_stats::snapshot().run_stop;
        merge_probe(
            6000,
            2,
            &ProbeRun {
                last_recover_step: Some(300),
                last_crossing_step: Some(400),
                completed_at: Some(300 + s + 1),
                response_steps: &[],
            },
        );
        merge_probe(
            6000,
            2,
            &ProbeRun {
                last_recover_step: Some(300),
                last_crossing_step: Some(400),
                completed_at: Some(300 + s),
                response_steps: &[],
            },
        );
        let after = util_stats::snapshot().run_stop;
        util_stats::set_enabled(false);
        assert_eq!(
            after.probe_over_stop_completions - before.probe_over_stop_completions,
            1,
            "only the completion later than recover + settle is over the stop"
        );
        assert_eq!(after.probes_keyed - before.probes_keyed, 2);
        reset();
    }

    #[test]
    fn response_gaps_are_read_from_the_last_recover_on_probes_with_a_recover() {
        let _serial = config_override::exclusive_session();
        util_stats::set_enabled(true);
        reset();
        let before = util_stats::snapshot().run_stop;
        merge_probe(
            6000,
            -1,
            &ProbeRun {
                last_recover_step: Some(100),
                last_crossing_step: None,
                completed_at: None,
                response_steps: &[50, 90, 110, 140, 200],
            },
        );
        let after = util_stats::snapshot().run_stop;
        util_stats::set_enabled(false);
        // Gaps 10 (from the recover), 30 and 60; the responses before the
        // recover are not read.
        assert_eq!(after.response_gap_count - before.response_gap_count, 3);
        assert_eq!(after.response_gap_sum - before.response_gap_sum, 100);
        assert_eq!(
            after.probes_with_response_after_recover - before.probes_with_response_after_recover,
            1
        );
        assert_eq!(after.response_gap_hist.le_16 - before.response_gap_hist.le_16, 1);
        assert_eq!(after.response_gap_hist.le_32 - before.response_gap_hist.le_32, 1);
        assert_eq!(after.response_gap_hist.le_64 - before.response_gap_hist.le_64, 1);
        reset();
    }

    #[test]
    fn decay_delays_the_next_checkpoint_and_the_settle_survives_it() {
        let _serial = config_override::exclusive_session();
        reset();
        for _ in 0..200 {
            merge_probe(6000, -1, &keyed(300, 400));
        }
        let engaged = settle(6000, -1).expect("engaged");
        decay(0.5);
        assert_eq!(settle(6000, -1), Some(engaged), "the settle survives decay unchanged");
        // Decay halved the keyed count to 100; 300 more keyed probes re-cross
        // the 400 checkpoint and the recompute reads the mixed histogram.
        for _ in 0..300 {
            merge_probe(6000, -1, &keyed(300, 1500));
        }
        // A settle of 1200 lands in cell 50 with upper edge 1223.
        assert_eq!(settle(6000, -1), Some(1835), "the recompute follows the fresher settles");
        reset();
    }

    #[test]
    fn the_stop_step_needs_a_settle_a_recover_and_a_crossing_after_it() {
        assert_eq!(stop_step(None, Some(300), Some(400)), None, "a scope under its floor");
        assert_eq!(stop_step(Some(179), None, Some(400)), None, "no recover applied");
        assert_eq!(stop_step(Some(179), Some(300), None), None, "no crossing entry");
        assert_eq!(stop_step(Some(179), Some(300), Some(300)), None, "no crossing after the recover");
        assert_eq!(stop_step(Some(179), Some(300), Some(250)), None, "the crossing came before");
        assert_eq!(stop_step(Some(179), Some(300), Some(301)), Some(479));
        assert_eq!(stop_step(Some(i32::MAX), Some(300), Some(301)), Some(i32::MAX));
    }

    #[test]
    fn the_treated_half_is_a_function_of_the_id_and_spares_every_probe() {
        let n = 64_000i64;
        let mut treated = 0i64;
        let mut eligible = 0i64;
        for id in -n / 2..n / 2 {
            let t = is_treated(id);
            assert_eq!(t, is_treated(id), "run {id}: the split must not vary");
            let probe = run_cap::is_probe(id)
                || timer_context::run_mode(id) == timer_context::RunMode::Probe;
            if probe {
                assert!(!t, "run {id}: a probe is treated");
                continue;
            }
            eligible += 1;
            treated += t as i64;
        }
        let share = treated as f64 / eligible as f64;
        assert!((share - 0.5).abs() < 0.02, "the treated share is {share}");
    }
}
