//! At a post-fault client operation's target, fault-touched records already
//! in flight are held until the operation's response leaves the target.
//!
//! A coordinator that receives a client request while messages touched by a
//! fault are on their way to it serves the request before that news
//! arrives. A record is fault-touched when its sender is down or has
//! restarted since sending, or when its sender has restarted and sent it
//! after finishing its restart opening: the sends a restarted node issues
//! before its first handler entry are its opening and are left alone, so a
//! recovering peer's request still lands.
//!
//! On the treated half of the runs, when a post-fault operation is invoked
//! at a target that is not in its own restart opening and has no crash
//! queued, every such record addressed to the target is moved out of the
//! network queue into the delay queue for a fixed bound, tagged, and keyed
//! on the operation. It is released the step the operation's response is
//! recorded or the stall release settles the operation, when nothing else
//! in the run is eligible, or at the bound. Records sent after the
//! invocation, channel sends, client-origin records and records to other
//! destinations are never touched.
//!
//! Held records do not suspend the stall clock: the hold is a scheduling
//! choice about order, not work the run owes, so a run wedged with only
//! held records still reaches its stall cap.
//!
//! The treated half is drawn under a salt of its own, so the split is
//! independent of every other split of a session. Probes take no
//! treatment: run-cap probes feed the length learners, and timer-context
//! probes must run unsteered.

use crate::simulator::core::state::Runnable;
use crate::simulator::fresh_first::RecordKey;
use crate::simulator::hash_utils::HashPolicy;
use crate::simulator::run_cap;
use crate::simulator::run_phase;
use crate::simulator::timer_context;
use crate::simulator::util_stats::DeliveryBias;
use std::collections::HashMap;

/// Salt for the treated half. Distinct from every other split of a session.
pub const SHELTER_SALT: u64 = 0x_4F50_5348_454C_5452; // "OPSHELTR"

/// Steps a sheltered record is held at most.
pub const BOUND_STEPS: i32 = 192;

/// Whether this run shelters a post-fault operation's target.
pub fn is_treated(run_id: i64) -> bool {
    !run_cap::is_probe(run_id)
        && timer_context::run_mode(run_id) != timer_context::RunMode::Probe
        && run_phase::salted_phase(run_id, SHELTER_SALT, 2) == 1
}

/// Whether a runnable is a sheltered record.
pub fn is_sheltered<H: HashPolicy>(r: &Runnable<H>) -> bool {
    matches!(r, Runnable::Record(rec) if rec.bias.contains(DeliveryBias::SHELTERED))
}

/// Why a sheltered record was released.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Release {
    /// The operation's response was recorded, or the stall release settled
    /// the operation.
    Response,
    /// The bound passed.
    Expiry,
    /// Nothing else in the run was eligible.
    Dry,
}

/// The class of a sheltered record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    /// Sent by an incarnation that died, or by a sender that is down.
    Ghost,
    /// Sent by a restarted sender's current incarnation after its opening.
    SettledFresh,
}

#[derive(Clone, Debug)]
struct Held {
    op: i32,
    sheltered_step: i32,
    reason: Option<Release>,
}

/// One run's shelter state: every sheltered record still in the delay
/// queue, keyed by record, and the records of each operation.
#[derive(Clone, Debug, Default)]
pub struct RunState {
    /// The run is on the treated half.
    pub enabled: bool,
    held: HashMap<RecordKey, Held>,
    by_op: HashMap<i32, Vec<RecordKey>>,
}

impl RunState {
    /// The record `key` was sheltered for operation `op` at `step`.
    pub fn shelter(&mut self, op: i32, key: RecordKey, step: i32) {
        self.held.insert(
            key,
            Held {
                op,
                sheltered_step: step,
                reason: None,
            },
        );
        self.by_op.entry(op).or_default().push(key);
    }

    /// Sheltered records still in the delay queue.
    pub fn held_len(&self) -> usize {
        self.held.len()
    }

    /// Whether `key` is sheltered.
    pub fn holds(&self, key: RecordKey) -> bool {
        self.held.contains_key(&key)
    }

    /// Mark every sheltered record of `op` for release with `reason` and
    /// return their keys. A record already marked keeps its first reason.
    pub fn mark_op(&mut self, op: i32, reason: Release) -> Vec<RecordKey> {
        let keys = self.by_op.remove(&op).unwrap_or_default();
        self.mark(&keys, reason);
        keys
    }

    /// Mark every sheltered record for release with `reason` and return
    /// their keys.
    pub fn mark_all(&mut self, reason: Release) -> Vec<RecordKey> {
        let mut keys: Vec<RecordKey> = self.held.keys().copied().collect();
        keys.sort_unstable();
        self.by_op.clear();
        self.mark(&keys, reason);
        keys
    }

    fn mark(&mut self, keys: &[RecordKey], reason: Release) {
        for key in keys {
            if let Some(h) = self.held.get_mut(key)
                && h.reason.is_none()
            {
                h.reason = Some(reason);
            }
        }
    }

    /// The record `key` left the delay queue at `step`: why, and how many
    /// steps it was held. None when it was not sheltered.
    pub fn released(&mut self, key: RecordKey, step: i32) -> Option<(Release, i32)> {
        let h = self.held.remove(&key)?;
        if let Some(keys) = self.by_op.get_mut(&h.op) {
            keys.retain(|k| *k != key);
            if keys.is_empty() {
                self.by_op.remove(&h.op);
            }
        }
        Some((
            h.reason.unwrap_or(Release::Expiry),
            (step - h.sheltered_step).max(0),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::simulator::config_override;

    #[test]
    fn the_treated_half_is_half_the_unprobed_runs_and_independent_of_the_other_splits() {
        let _serial = config_override::exclusive_session();
        let n = 64_000i64;
        let mut treated = 0i64;
        let mut eligible = 0i64;
        let mut with_wait = 0i64;
        let mut with_anchor = 0i64;
        for id in 0..n {
            let t = is_treated(id);
            assert_eq!(t, is_treated(id), "the split must not vary between reads");
            let probe = run_cap::is_probe(id)
                || timer_context::run_mode(id) == timer_context::RunMode::Probe;
            if probe {
                assert!(!t, "probe {id} is treated");
                continue;
            }
            eligible += 1;
            treated += t as i64;
            with_wait += (t == crate::simulator::request_wait::is_treated(id)) as i64;
            with_anchor += (t == crate::simulator::client_anchor::is_treated(id)) as i64;
        }
        let share = treated as f64 / eligible as f64;
        assert!((share - 0.5).abs() < 0.02, "the treated half takes {share}");
        let overlap = with_wait as f64 / eligible as f64;
        assert!((overlap - 0.5).abs() < 0.03, "the shelter follows the wait split at {overlap}");
        let overlap = with_anchor as f64 / eligible as f64;
        assert!((overlap - 0.5).abs() < 0.03, "the shelter follows the anchor split at {overlap}");
    }

    #[test]
    fn a_release_keeps_its_first_reason_and_an_unmarked_release_is_an_expiry() {
        let mut st = RunState::default();
        st.shelter(4, (1, 9), 100);
        st.shelter(4, (2, 3), 100);
        st.shelter(5, (2, 4), 101);
        assert_eq!(st.held_len(), 3);
        assert!(st.holds((1, 9)));
        let mut keys = st.mark_op(4, Release::Response);
        keys.sort_unstable();
        assert_eq!(keys, vec![(1, 9), (2, 3)]);
        assert!(st.mark_op(4, Release::Response).is_empty(), "an operation is marked once");
        let all = st.mark_all(Release::Dry);
        assert_eq!(all, vec![(1, 9), (2, 3), (2, 4)]);
        assert_eq!(st.released((1, 9), 110), Some((Release::Response, 10)));
        assert_eq!(st.released((2, 4), 112), Some((Release::Dry, 11)));
        assert_eq!(st.released((2, 4), 112), None, "a record is released once");
        assert_eq!(st.released((7, 7), 112), None, "an unsheltered record is not counted");
        let mut fresh = RunState::default();
        fresh.shelter(1, (3, 3), 50);
        assert_eq!(fresh.released((3, 3), 50 + BOUND_STEPS), Some((Release::Expiry, BOUND_STEPS)));
        assert_eq!(fresh.held_len(), 0);
        assert!(!fresh.holds((3, 3)));
    }
}
