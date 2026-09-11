//! A record caused by a post-fault client operation waits at a restarted
//! destination until that node has heard back from a majority of the peers
//! its restart addressed.
//!
//! A node that comes back from a crash and asks its peers for state takes
//! nothing from a client-caused message until a majority of those peers
//! have answered it. The peers a restart addressed are the remote
//! destinations of the records the node sent before its first handler entry
//! after the restart; a peer has answered once a message entry from its
//! current incarnation changed the restarted node's state. A restart that
//! sends nothing has an empty opening, and the wait never applies there.
//!
//! On the treated half of the runs the wait is an eligibility mask in the
//! scheduler: the record stays in the network queue and is not offered
//! while the destination is unsettled, for at most the learned ghost-lag
//! bound counted from the restart. When the mask would leave a step with
//! nothing to run it is lifted for that step, so no run idles or reads as a
//! deadlock. Channel sends, timers, faults, records from a dead or downed
//! incarnation and records not caused by a post-fault operation are never
//! masked.
//!
//! The treated half is drawn under a salt of its own, so the split is
//! independent of every other split of a session. Probes take no
//! treatment: run-cap probes feed the length learners, and timer-context
//! probes must run unsteered.

use crate::simulator::core::state::SendLedger;
use crate::simulator::fresh_first::RecordKey;
use crate::simulator::run_cap;
use crate::simulator::run_phase;
use crate::simulator::timer_context;
use std::collections::HashMap;

/// Salt for the treated half. Distinct from every other split of a session.
pub const REQUEST_WAIT_SALT: u64 = 0x_5245_5157_4149_5453; // "REQWAITS"

/// The bound from the restart when the run's scope has learned no ghost-lag
/// quantile yet.
pub const DEFAULT_BOUND: i32 = 32;

/// Whether this run masks request-caused records at unsettled restarted
/// destinations.
pub fn is_treated(run_id: i64) -> bool {
    !run_cap::is_probe(run_id)
        && timer_context::run_mode(run_id) != timer_context::RunMode::Probe
        && run_phase::salted_phase(run_id, REQUEST_WAIT_SALT, 2) == 1
}

/// Whether a node has heard back from a majority of the peers its restart
/// addressed. A node whose restart addressed nobody is settled.
pub fn settled(l: &SendLedger) -> bool {
    let peers = l.opening_peers.count_ones();
    peers == 0 || 2 * (l.opening_replied & l.opening_peers).count_ones() > peers
}

/// How a masked record's wait ended, read when the record is taken.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Release {
    /// The destination settled.
    Settled,
    /// The bound from the restart passed.
    Bound,
    /// The mask was lifted for the step because nothing else could run.
    Lifted,
}

/// One run's wait state. `masked` holds, per record still masked or not yet
/// taken, the step it was first masked at.
#[derive(Clone, Debug, Default)]
pub struct RunState {
    /// The run is on the treated half.
    pub enabled: bool,
    masked: HashMap<RecordKey, i32>,
}

impl RunState {
    /// The record `key` is masked at `step`. True the first time in the run.
    pub fn mask(&mut self, key: RecordKey, step: i32) -> bool {
        let mut first = false;
        self.masked.entry(key).or_insert_with(|| {
            first = true;
            step
        });
        first
    }

    /// Whether `key` has been masked at some step of this run.
    pub fn was_masked(&self, key: RecordKey) -> bool {
        self.masked.contains_key(&key)
    }

    /// The record `key` is being taken: the step it was first masked at, or
    /// None when it never was.
    pub fn take(&mut self, key: RecordKey) -> Option<i32> {
        self.masked.remove(&key)
    }

    /// Records masked at some step and not yet taken.
    pub fn masked_len(&self) -> usize {
        self.masked.len()
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
        let mut with_shelter = 0i64;
        let mut with_fresh = 0i64;
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
            with_shelter += (t == crate::simulator::op_shelter::is_treated(id)) as i64;
            with_fresh += (t == crate::simulator::fresh_first::is_treated(id)) as i64;
        }
        let share = treated as f64 / eligible as f64;
        assert!((share - 0.5).abs() < 0.02, "the treated half takes {share}");
        let overlap = with_shelter as f64 / eligible as f64;
        assert!((overlap - 0.5).abs() < 0.03, "the wait follows the shelter split at {overlap}");
        let overlap = with_fresh as f64 / eligible as f64;
        assert!((overlap - 0.5).abs() < 0.03, "the wait follows the fresh-first split at {overlap}");
    }

    #[test]
    fn a_node_is_settled_once_a_majority_of_its_opening_peers_answered() {
        let mut l = SendLedger::default();
        assert!(settled(&l), "an empty opening is settled");
        l.opening_peers = 0b0110;
        assert!(!settled(&l));
        l.opening_replied = 0b0010;
        assert!(!settled(&l), "one of two is not a majority");
        l.opening_replied = 0b0110;
        assert!(settled(&l));
        l.opening_peers = 0b0111;
        l.opening_replied = 0b0011;
        assert!(settled(&l), "two of three is a majority");
        l.opening_replied = 0b1001;
        assert!(!settled(&l), "a reply from outside the opening does not count");
    }

    #[test]
    fn a_masked_record_is_counted_once_and_taken_with_its_first_step() {
        let mut st = RunState::default();
        assert!(st.mask((1, 7), 10));
        assert!(!st.mask((1, 7), 11), "a second masking is not a new record");
        assert!(st.mask((2, 7), 11));
        assert!(st.was_masked((1, 7)));
        assert!(!st.was_masked((3, 0)));
        assert_eq!(st.masked_len(), 2);
        assert_eq!(st.take((1, 7)), Some(10));
        assert_eq!(st.take((1, 7)), None);
        assert!(!st.was_masked((1, 7)));
        assert_eq!(st.take((3, 0)), None);
    }
}
