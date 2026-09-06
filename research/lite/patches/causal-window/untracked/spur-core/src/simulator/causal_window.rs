//! Dispatch-time skipping of records that have no post-fault cause while a
//! post-fault client operation is in flight, and of records sent in
//! reaction to a fault-crossing delivery at a restarted node.
//!
//! Once a client operation issued after the run's first crash is in flight,
//! its own records race against one-hop records that left before it
//! existed: the view-change traffic a restarted node sent when it took a
//! delivery from a dead incarnation, and the sends of the dead incarnations
//! themselves. Which of the two classes lands first at each destination
//! decides whether the operation commits before the view moves on.
//!
//! The axis has three directions drawn per run under one salt. On the
//! CLIENT_FIRST quarter a window opens at each post-fault operation's
//! invocation and closes at its completion or a fixed number of steps
//! later; while a window is open the network draw skips every remote
//! record between nodes of one role that has no post-fault cause, except
//! replies to the destination's current incarnation and the sends of a
//! node's restart. On the CONSEQUENCE quarter the sends of a segment at a
//! restarted node that changed state on a fault-crossing delivery are
//! skipped from their send, together with the sends of a local record such
//! a segment issued, until post-fault client work reaches their destination
//! or is answered, or the flag ages out. The stock half skips nothing.
//!
//! Both directions act through the eligibility test of the scheduler and
//! consume no random draw: a run on which nothing is skipped reads the same
//! random sequence as a stock run. A step on which the skip leaves nothing
//! eligible is reselected without it, so no run stalls on the skip alone.
//!
//! Every classification reads a per-run table of handler segments: for each
//! node, the range of send ordinals each handler entry issued, what entered
//! it, and the flag it carries. The table is kept only on the two treated
//! directions.

use crate::simulator::core::state::HandlerTrigger;
use crate::simulator::run_cap;
use crate::simulator::run_phase;
use crate::simulator::timer_context;
use std::collections::{HashMap, HashSet};

/// Salt for the direction draw. Distinct from every other split of a
/// session.
pub const CAUSAL_WINDOW_SALT: u64 = 0x_4341_5553_414C_574E; // "CAUSALWN"

/// A window closes this many steps after it opened when its operation has
/// not completed by then, and a flag ages out after this many idle steps.
pub const EXPIRY_STEPS: i32 = crate::simulator::client_anchor::EXPIRY_STEPS;

/// A flag is released this many steps after it was raised whether or not
/// the run was idle in between, so a stuck client operation cannot hold
/// the flagged records for the rest of the run.
pub const FLAG_ABSOLUTE_CAP_STEPS: i32 = 3 * EXPIRY_STEPS;

/// A direction on the causal-window axis.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Arm {
    /// Nothing is skipped.
    #[default]
    Stock,
    /// Records with no post-fault cause wait while a post-fault operation is
    /// in flight.
    ClientFirst,
    /// Records sent in reaction to a fault-crossing delivery at a restarted
    /// node wait from their send.
    Consequence,
}

impl Arm {
    /// The index this direction occupies in a per-arm counter and on its
    /// axis.
    pub fn index(self) -> usize {
        match self {
            Arm::Stock => 0,
            Arm::ClientFirst => 1,
            Arm::Consequence => 2,
        }
    }

    /// The inverse of `index`.
    pub fn from_index(i: usize) -> Self {
        match i {
            0 => Arm::Stock,
            1 => Arm::ClientFirst,
            _ => Arm::Consequence,
        }
    }
}

/// Whether the run id names a run the axis may act on: neither kind of
/// probe.
fn is_eligible(run_id: i64) -> bool {
    !run_cap::is_probe(run_id)
        && timer_context::run_mode(run_id) != timer_context::RunMode::Probe
}

/// The direction this run draws: two phases of four are stock, one is each
/// treated direction.
pub fn arm(run_id: i64) -> Arm {
    if !is_eligible(run_id) {
        return Arm::Stock;
    }
    match run_phase::salted_phase(run_id, CAUSAL_WINDOW_SALT, 4) {
        2 => Arm::ClientFirst,
        3 => Arm::Consequence,
        _ => Arm::Stock,
    }
}

/// Whether this run opens a window at each post-fault client operation.
pub fn is_client_first(run_id: i64) -> bool {
    arm(run_id) == Arm::ClientFirst
}

/// Whether this run skips the sends of flagged segments.
pub fn is_consequence(run_id: i64) -> bool {
    arm(run_id) == Arm::Consequence
}

/// A record's identity within a run: the sending node's index and the
/// position of the send among that node's sends.
pub type RecordKey = (usize, u32);

/// What a handler segment was entered by, carried by every record the
/// segment sent and by the segments its local records enter in turn.
/// `source` is the sending node and incarnation of the remote record that
/// entered the segment, or `None` for a timer or restart segment;
/// `trigger` is what woke the handler, `None` for a node's restart; `flag`
/// is the index of the flag the segment carries, if any.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Lineage {
    pub source: Option<(usize, u32)>,
    pub trigger: HandlerTrigger,
    pub flag: Option<usize>,
}

/// The send-ordinal range `from..to` one handler segment issued at a node.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Segment {
    pub from: u32,
    pub to: u32,
    pub lineage: Lineage,
}

/// Why a flag stopped holding its records everywhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Release {
    /// A post-fault client operation completed.
    Response,
    /// The flag aged past `EXPIRY_STEPS` idle steps.
    IdleCap,
    /// The flag aged past `FLAG_ABSOLUTE_CAP_STEPS` steps of any kind.
    AbsCap,
}

/// Why a held record was allowed to dispatch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HeldRelease {
    /// Post-fault client work reached the record's destination.
    PeerEntry,
    Response,
    IdleCap,
    AbsCap,
    /// Nothing else could run, so the skip was lifted for the step.
    Lift,
}

/// One flag: the step it was raised at, the idle steps it has aged, and
/// how and when it was released run-wide, if it was.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Flag {
    pub step: i32,
    pub idle_steps: i32,
    pub released: Option<(i32, Release)>,
}

/// Why a window closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Close {
    /// The operation completed.
    Response,
    /// `EXPIRY_STEPS` passed since the window opened.
    Cap,
}

/// The window open for one post-fault client operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Window {
    pub op_id: i32,
    pub opened_step: i32,
}

/// How a handler segment is entered, which fixes the lineage of its sends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Entry {
    /// A remote record's first entry at its destination.
    Remote { origin: usize, incarnation: u32 },
    /// A timer firing woke the record.
    Timer,
    /// A record the node sent to itself enters for the first time.
    LocalFirst,
    /// A record resumes after a yield.
    Continuation,
    /// The node's restart.
    Restart,
}

/// A segment that has begun executing: where its sends start and what it
/// was entered by. `propagate` is the flag a local record carries in from
/// the segment that sent it, applied only if this segment acts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpenSegment {
    pub dest: usize,
    pub key: RecordKey,
    pub from: u32,
    pub lineage: Lineage,
    pub propagate: Option<usize>,
}

/// What a segment's close did to the table.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Closed {
    /// The segment raised a new flag.
    pub flagged: bool,
    /// The segment took a flag from the local record that entered it.
    pub flagged_via_local: bool,
}

/// What a queued remote record looks like to the skip tests.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecordView {
    pub key: RecordKey,
    pub dest: usize,
    /// The sender and the receiver have the same role.
    pub same_role: bool,
    pub caused_post_fault: bool,
    /// The receiver's current incarnation.
    pub dest_incarnation: u32,
}

/// One run's direction and everything the skip tests read.
#[derive(Clone, Debug, Default)]
pub struct RunState {
    pub arm: Arm,
    /// Per node, the segments it ran that sent anything, in send order.
    segments: Vec<Vec<Segment>>,
    /// The lineage of the last segment each record entered.
    lineage: HashMap<RecordKey, Lineage>,
    flags: Vec<Flag>,
    /// Indices into `flags` of the flags not yet released run-wide.
    open_flags: Vec<usize>,
    window: Option<Window>,
    /// Operations that have had a window; none gets a second.
    windowed_ops: HashSet<i32>,
    masked_seen: HashSet<RecordKey>,
    held_seen: HashSet<RecordKey>,
    /// Per node, the step of the last message entry from a node of its own
    /// role that was caused by a post-fault operation and changed state,
    /// -1 when none.
    post_fault_entry_step: Vec<i32>,
}

impl RunState {
    /// Whether the run keeps the segment table.
    pub fn enabled(&self) -> bool {
        self.arm != Arm::Stock
    }

    /// Whether something may be skipped at this step: a window is open or a
    /// flag is unreleased. An untreated run reads this and nothing else.
    pub fn active(&self) -> bool {
        self.window.is_some() || !self.open_flags.is_empty()
    }

    pub fn window(&self) -> Option<Window> {
        self.window
    }

    pub fn flags(&self) -> &[Flag] {
        &self.flags
    }

    pub fn segments_of(&self, node: usize) -> &[Segment] {
        self.segments.get(node).map(Vec::as_slice).unwrap_or(&[])
    }

    fn ensure_node(&mut self, node: usize) {
        if self.segments.len() <= node {
            self.segments.resize(node + 1, Vec::new());
        }
        if self.post_fault_entry_step.len() <= node {
            self.post_fault_entry_step.resize(node + 1, -1);
        }
    }

    /// The lineage of the segment at `node` that issued send `ordinal`.
    pub fn lineage_of_send(&self, node: usize, ordinal: u32) -> Option<Lineage> {
        let segments = self.segments.get(node)?;
        let i = segments.partition_point(|s| s.to <= ordinal);
        let s = segments.get(i)?;
        (s.from <= ordinal && ordinal < s.to).then_some(s.lineage)
    }

    /// The lineage a record carries: that of the last segment it entered,
    /// else that of the segment that sent it.
    pub fn lineage_of_record(&self, key: RecordKey) -> Option<Lineage> {
        self.lineage
            .get(&key)
            .copied()
            .or_else(|| self.lineage_of_send(key.0, key.1))
    }

    /// A segment at `dest` begins for the record `key`, entered by `entry`;
    /// `issued` is the node's send count now and `ledger_trigger` what its
    /// ledger says woke its last handler.
    pub fn begin_segment(
        &mut self,
        dest: usize,
        key: RecordKey,
        entry: Entry,
        issued: u32,
        ledger_trigger: HandlerTrigger,
    ) -> OpenSegment {
        self.ensure_node(dest);
        let fallback = Lineage {
            source: None,
            trigger: ledger_trigger,
            flag: None,
        };
        let mut propagate = None;
        let lineage = match entry {
            Entry::Remote { origin, incarnation } => Lineage {
                source: Some((origin, incarnation)),
                trigger: HandlerTrigger::Delivery,
                flag: None,
            },
            Entry::Timer => Lineage {
                source: None,
                trigger: HandlerTrigger::Timer,
                flag: None,
            },
            Entry::Restart => Lineage {
                source: None,
                trigger: HandlerTrigger::None,
                flag: None,
            },
            Entry::LocalFirst => {
                let parent = self.lineage_of_send(dest, key.1).unwrap_or(fallback);
                propagate = parent.flag.filter(|&f| self.is_open(f));
                Lineage {
                    flag: None,
                    ..parent
                }
            }
            Entry::Continuation => self.lineage_of_record(key).unwrap_or(fallback),
        };
        OpenSegment {
            dest,
            key,
            from: issued,
            lineage,
            propagate,
        }
    }

    /// The segment `open` finished with the node's send count at `to`;
    /// `acted` says it changed the node's state and `flag_step` names the
    /// step of a new flag it raises. A local record's flag is taken only
    /// when the segment acted.
    pub fn end_segment(
        &mut self,
        open: OpenSegment,
        to: u32,
        acted: bool,
        flag_step: Option<i32>,
    ) -> Closed {
        let mut lineage = open.lineage;
        let mut closed = Closed::default();
        if let Some(step) = flag_step {
            lineage.flag = Some(self.raise_flag(step));
            closed.flagged = true;
        } else if acted && let Some(f) = open.propagate {
            lineage.flag = Some(f);
            closed.flagged_via_local = true;
        }
        self.ensure_node(open.dest);
        if to > open.from {
            self.segments[open.dest].push(Segment {
                from: open.from,
                to,
                lineage,
            });
        }
        self.lineage.insert(open.key, lineage);
        closed
    }

    fn raise_flag(&mut self, step: i32) -> usize {
        self.flags.push(Flag {
            step,
            idle_steps: 0,
            released: None,
        });
        let i = self.flags.len() - 1;
        self.open_flags.push(i);
        i
    }

    fn is_open(&self, flag: usize) -> bool {
        self.flags.get(flag).is_some_and(|f| f.released.is_none())
    }

    /// `dest` took a message entry from a node of its own role caused by a
    /// post-fault client operation, and the entry changed its state.
    pub fn note_post_fault_entry(&mut self, dest: usize, step: i32) {
        self.ensure_node(dest);
        self.post_fault_entry_step[dest] = self.post_fault_entry_step[dest].max(step);
    }

    /// Whether the record `r` is skipped at the network draw by the window
    /// rule: a window is open, the record is between nodes of one role and
    /// has no post-fault cause, and it is neither a reply to the
    /// destination's current incarnation nor a restart send.
    pub fn masks(&self, r: &RecordView) -> bool {
        if self.arm != Arm::ClientFirst || self.window.is_none() {
            return false;
        }
        if !r.same_role || r.caused_post_fault {
            return false;
        }
        let Some(l) = self.lineage_of_send(r.key.0, r.key.1) else {
            return true;
        };
        if l.trigger == HandlerTrigger::None {
            return false;
        }
        l.source != Some((r.dest, r.dest_incarnation))
    }

    /// Whether the record `r` is skipped by the flag rule: it was sent by a
    /// flagged segment whose flag is unreleased, and post-fault client work
    /// has not reached its destination since the flag was raised.
    pub fn holds(&self, r: &RecordView) -> bool {
        if self.arm != Arm::Consequence || !r.same_role {
            return false;
        }
        let Some(flag) = self.lineage_of_send(r.key.0, r.key.1).and_then(|l| l.flag) else {
            return false;
        };
        self.flag_holds_at(flag, r.dest)
    }

    fn flag_holds_at(&self, flag: usize, dest: usize) -> bool {
        let Some(f) = self.flags.get(flag) else {
            return false;
        };
        f.released.is_none()
            && self
                .post_fault_entry_step
                .get(dest)
                .is_none_or(|&s| s < f.step)
    }

    /// Whether `r` is skipped at this step by either rule, remembering
    /// the record so it is counted once. Returns which rule fired.
    pub fn skip(&mut self, r: &RecordView) -> Skip {
        if self.masks(r) {
            Skip::Masked {
                first: self.masked_seen.insert(r.key),
            }
        } else if self.holds(r) {
            Skip::Held {
                first: self.held_seen.insert(r.key),
            }
        } else {
            Skip::None
        }
    }

    /// The record `key` addressed to `dest` is dispatched. If it had been
    /// held, says what released it; `lifted` says the step's skip was
    /// lifted.
    pub fn note_dispatch(&mut self, key: RecordKey, dest: usize, lifted: bool) -> Option<HeldRelease> {
        self.masked_seen.remove(&key);
        if !self.held_seen.remove(&key) {
            return None;
        }
        let flag = self
            .lineage_of_send(key.0, key.1)
            .and_then(|l| l.flag)
            .and_then(|f| self.flags.get(f).copied());
        let Some(f) = flag else {
            return Some(HeldRelease::Lift);
        };
        let peer = self
            .post_fault_entry_step
            .get(dest)
            .copied()
            .filter(|&s| s >= f.step);
        let global = f.released;
        Some(match (peer, global) {
            (Some(p), Some((g, _))) if p <= g => HeldRelease::PeerEntry,
            (Some(_), None) => HeldRelease::PeerEntry,
            (_, Some((_, Release::Response))) => HeldRelease::Response,
            (_, Some((_, Release::IdleCap))) => HeldRelease::IdleCap,
            (_, Some((_, Release::AbsCap))) => HeldRelease::AbsCap,
            (None, None) => {
                debug_assert!(lifted, "a held record dispatched with its flag in force");
                HeldRelease::Lift
            }
        })
    }

    /// A post-fault client operation was invoked at `step`. Opens a window
    /// for it on the window direction when none is open and the operation
    /// never had one.
    pub fn invoked(&mut self, op_id: i32, step: i32) -> bool {
        if self.arm != Arm::ClientFirst || self.window.is_some() {
            return false;
        }
        self.open_window(op_id, step)
    }

    fn open_window(&mut self, op_id: i32, step: i32) -> bool {
        if !self.windowed_ops.insert(op_id) {
            return false;
        }
        self.window = Some(Window {
            op_id,
            opened_step: step,
        });
        true
    }

    /// The operation `op_id` completed at `step`; `post_fault` says it was
    /// invoked after the run's first crash and `outstanding` lists the
    /// post-fault operations still in flight in id order. Returns whether
    /// the open window was the operation's, and the operation a new window
    /// opened for.
    pub fn completed(&mut self, op_id: i32, step: i32, post_fault: bool, outstanding: &[i32]) -> Completion {
        let mut out = Completion::default();
        if post_fault && self.arm == Arm::Consequence {
            out.released = self.release_all(step, Release::Response);
        }
        if self.window.is_some_and(|w| w.op_id == op_id) {
            self.window = None;
            out.closed = Some(Close::Response);
            out.opened = self.open_next(step, outstanding);
        }
        out
    }

    fn open_next(&mut self, step: i32, outstanding: &[i32]) -> Option<i32> {
        let next = outstanding
            .iter()
            .copied()
            .find(|op| !self.windowed_ops.contains(op))?;
        self.open_window(next, step).then_some(next)
    }

    fn release_all(&mut self, step: i32, why: Release) -> usize {
        let open = std::mem::take(&mut self.open_flags);
        let n = open.len();
        for i in open {
            self.flags[i].released = Some((step, why));
        }
        n
    }

    /// A step begins at `step`; `idle` says no post-fault operation is held
    /// or outstanding and `outstanding` lists the ones in flight in id
    /// order. Ages the flags and closes a window past its cap.
    pub fn tick(&mut self, step: i32, idle: bool, outstanding: &[i32]) -> Tick {
        let mut out = Tick::default();
        if self.arm == Arm::Consequence && !self.open_flags.is_empty() {
            let mut still_open = Vec::with_capacity(self.open_flags.len());
            for i in std::mem::take(&mut self.open_flags) {
                let f = &mut self.flags[i];
                if idle {
                    f.idle_steps += 1;
                }
                if step - f.step >= FLAG_ABSOLUTE_CAP_STEPS {
                    f.released = Some((step, Release::AbsCap));
                    out.abs_capped += 1;
                } else if f.idle_steps >= EXPIRY_STEPS {
                    f.released = Some((step, Release::IdleCap));
                    out.idle_capped += 1;
                } else {
                    still_open.push(i);
                }
            }
            self.open_flags = still_open;
        }
        if let Some(w) = self.window
            && step >= w.opened_step + EXPIRY_STEPS
        {
            self.window = None;
            out.closed = Some(Close::Cap);
            out.opened = self.open_next(step, outstanding);
        }
        out
    }

    /// Whether a queued record whose flag is `flag`, addressed to `dest`,
    /// is held now.
    pub fn flag_in_force(&self, flag: Option<usize>, dest: usize) -> bool {
        flag.is_some_and(|f| self.flag_holds_at(f, dest))
    }
}

/// What a record's skip test found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Skip {
    None,
    /// The window rule; `first` says this record had not been skipped
    /// before.
    Masked { first: bool },
    /// The flag rule; `first` as above.
    Held { first: bool },
}

/// What an operation's completion did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Completion {
    pub closed: Option<Close>,
    pub opened: Option<i32>,
    /// Flags released by the response.
    pub released: usize,
}

/// What a step's tick did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Tick {
    pub closed: Option<Close>,
    pub opened: Option<i32>,
    pub idle_capped: usize,
    pub abs_capped: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::simulator::config_override;

    #[test]
    fn the_three_directions_partition_the_eligible_runs_and_spare_the_probes() {
        let _serial = config_override::exclusive_session();
        let n = 40_000i64;
        let mut counts = [0i64; 3];
        let mut eligible = 0i64;
        for id in 0..n {
            let a = arm(id);
            assert_eq!(a, arm(id), "the direction must not vary between reads");
            assert_eq!(is_client_first(id), a == Arm::ClientFirst);
            assert_eq!(is_consequence(id), a == Arm::Consequence);
            assert_eq!(Arm::from_index(a.index()), a);
            let probe = run_cap::is_probe(id)
                || timer_context::run_mode(id) == timer_context::RunMode::Probe;
            if probe {
                assert_eq!(a, Arm::Stock, "probe {id} took a direction");
            } else {
                eligible += 1;
                counts[a.index()] += 1;
            }
        }
        assert_eq!(counts.iter().sum::<i64>(), eligible);
        let share = |a: Arm| counts[a.index()] as f64 / eligible as f64;
        assert!((share(Arm::Stock) - 0.5).abs() < 0.02, "stock takes {}", share(Arm::Stock));
        assert!(
            (share(Arm::ClientFirst) - 0.25).abs() < 0.02,
            "client-first takes {}",
            share(Arm::ClientFirst)
        );
        assert!(
            (share(Arm::Consequence) - 0.25).abs() < 0.02,
            "consequence takes {}",
            share(Arm::Consequence)
        );
    }

    fn view(key: RecordKey, dest: usize, caused: bool, dest_incarnation: u32) -> RecordView {
        RecordView {
            key,
            dest,
            same_role: true,
            caused_post_fault: caused,
            dest_incarnation,
        }
    }

    /// Node 1 runs three segments: one entered by a record from node 2 at
    /// incarnation 1 sending ordinals 0..2, a timer segment sending 2..3,
    /// and a restart segment sending 3..5.
    fn table() -> RunState {
        let mut st = RunState {
            arm: Arm::ClientFirst,
            ..RunState::default()
        };
        let open = st.begin_segment(
            1,
            (2, 7),
            Entry::Remote {
                origin: 2,
                incarnation: 1,
            },
            0,
            HandlerTrigger::Delivery,
        );
        st.end_segment(open, 2, true, None);
        let open = st.begin_segment(1, (1, 9), Entry::Timer, 2, HandlerTrigger::Timer);
        st.end_segment(open, 3, true, None);
        let open = st.begin_segment(1, (1, 3), Entry::Restart, 3, HandlerTrigger::None);
        st.end_segment(open, 5, false, None);
        st
    }

    #[test]
    fn the_segment_table_answers_a_send_by_its_ordinal() {
        let st = table();
        assert_eq!(st.segments_of(1).len(), 3);
        assert_eq!(
            st.lineage_of_send(1, 1).map(|l| l.source),
            Some(Some((2, 1)))
        );
        assert_eq!(st.lineage_of_send(1, 2).map(|l| l.trigger), Some(HandlerTrigger::Timer));
        assert_eq!(st.lineage_of_send(1, 4).map(|l| l.trigger), Some(HandlerTrigger::None));
        assert_eq!(st.lineage_of_send(1, 5), None, "past the last segment");
        assert_eq!(st.lineage_of_send(0, 0), None, "a node with no segment");
        assert_eq!(
            st.lineage_of_record((1, 3)).map(|l| l.trigger),
            Some(HandlerTrigger::None),
            "the record that entered the restart segment carries it"
        );
        assert_eq!(
            st.lineage_of_record((1, 4)).map(|l| l.trigger),
            Some(HandlerTrigger::None),
            "a record with no entry of its own carries the segment that sent it"
        );
        let mut st = st;
        let open = st.begin_segment(1, (1, 4), Entry::Continuation, 5, HandlerTrigger::Delivery);
        assert_eq!(open.lineage.trigger, HandlerTrigger::None, "a continuation keeps its lineage");
        st.end_segment(open, 5, false, None);
        assert_eq!(st.segments_of(1).len(), 3, "a segment that sent nothing is not a range");
    }

    #[test]
    fn the_window_rule_skips_uncaused_same_role_records_but_not_replies_or_restart_sends() {
        let mut st = table();
        assert!(!st.masks(&view((1, 0), 0, false, 0)), "no window is open");
        assert!(st.invoked(5, 10));
        assert!(st.masks(&view((1, 0), 0, false, 0)), "sent to node 0 from node 2's segment");
        assert!(!st.masks(&view((1, 0), 2, false, 1)), "a reply to node 2's current incarnation");
        assert!(st.masks(&view((1, 0), 2, false, 2)), "node 2 restarted since: no longer a reply");
        assert!(st.masks(&view((1, 2), 0, false, 0)), "a timer segment's send");
        assert!(!st.masks(&view((1, 3), 0, false, 0)), "a restart send");
        assert!(!st.masks(&view((1, 0), 0, true, 0)), "a caused record");
        assert!(
            !st.masks(&RecordView {
                same_role: false,
                ..view((1, 0), 0, false, 0)
            }),
            "a record across roles"
        );
        assert!(st.masks(&view((0, 0), 1, false, 0)), "a send with no segment on record");
        st.arm = Arm::Stock;
        assert!(!st.masks(&view((1, 0), 0, false, 0)), "stock skips nothing");
        st.arm = Arm::Consequence;
        assert!(!st.masks(&view((1, 0), 0, false, 0)), "the flag direction has no window");
    }

    #[test]
    fn a_window_closes_at_completion_or_at_its_cap_and_never_reopens_for_the_same_operation() {
        let mut st = RunState {
            arm: Arm::ClientFirst,
            ..RunState::default()
        };
        assert!(st.invoked(1, 10));
        assert_eq!(st.window(), Some(Window { op_id: 1, opened_step: 10 }));
        assert!(!st.invoked(2, 11), "one window at a time");
        let t = st.tick(10 + EXPIRY_STEPS - 1, false, &[1, 2]);
        assert_eq!(t.closed, None);
        assert!(st.active());
        let c = st.completed(1, 20, true, &[2]);
        assert_eq!(c.closed, Some(Close::Response));
        assert_eq!(c.opened, Some(2), "the next outstanding operation takes a window");
        assert_eq!(st.window(), Some(Window { op_id: 2, opened_step: 20 }));
        let t = st.tick(20 + EXPIRY_STEPS, false, &[2, 3]);
        assert_eq!(t.closed, Some(Close::Cap));
        assert_eq!(t.opened, Some(3), "operation 2 keeps no second window");
        let c = st.completed(3, 90, true, &[2]);
        assert_eq!(c.closed, Some(Close::Response));
        assert_eq!(c.opened, None);
        assert!(!st.invoked(2, 91), "a capped operation never gets another window");
        assert!(!st.active());
        let c = st.completed(2, 95, true, &[]);
        assert_eq!(c.closed, None, "no window was open for it");
        assert!(st.invoked(4, 96));
        let c = st.completed(9, 97, true, &[4]);
        assert_eq!(c.closed, None, "another operation's completion leaves the window");
        assert_eq!(st.window().map(|w| w.op_id), Some(4));
    }

    /// Node 1 restarted; a segment entered by a ghost from node 2 acted and
    /// sent ordinals 0..2 (to nodes 0 and 2) plus a local record at 2; the
    /// local record's entry acted and sent 3..5.
    fn flagged() -> RunState {
        let mut st = RunState {
            arm: Arm::Consequence,
            ..RunState::default()
        };
        let open = st.begin_segment(
            1,
            (2, 4),
            Entry::Remote {
                origin: 2,
                incarnation: 0,
            },
            0,
            HandlerTrigger::Delivery,
        );
        let closed = st.end_segment(open, 3, true, Some(30));
        assert!(closed.flagged);
        let open = st.begin_segment(1, (1, 2), Entry::LocalFirst, 3, HandlerTrigger::Delivery);
        assert_eq!(open.propagate, Some(0));
        let closed = st.end_segment(open, 5, true, None);
        assert!(closed.flagged_via_local);
        st
    }

    #[test]
    fn a_flagged_range_holds_its_records_and_propagates_one_hop_through_a_local_record() {
        let mut st = flagged();
        assert_eq!(st.flags().len(), 1, "the local record shares the flag");
        assert!(st.active());
        assert!(st.holds(&view((1, 0), 0, false, 0)));
        assert!(st.holds(&view((1, 1), 2, false, 1)));
        assert!(st.holds(&view((1, 4), 0, true, 0)), "the flag ignores the cause");
        assert!(!st.holds(&view((0, 0), 1, false, 1)), "a send with no flag");
        assert!(
            !st.holds(&RecordView {
                same_role: false,
                ..view((1, 0), 0, false, 0)
            }),
            "a record across roles"
        );
        let open = st.begin_segment(1, (1, 4), Entry::LocalFirst, 5, HandlerTrigger::Delivery);
        assert_eq!(open.propagate, Some(0));
        st.end_segment(open, 6, false, None);
        assert!(!st.holds(&view((1, 5), 0, false, 0)), "an inert segment takes no flag");
        let open = st.begin_segment(
            0,
            (1, 0),
            Entry::Remote {
                origin: 1,
                incarnation: 1,
            },
            0,
            HandlerTrigger::Delivery,
        );
        assert_eq!(open.propagate, None, "a remote record never carries the flag on");
        st.end_segment(open, 1, true, None);
        assert!(!st.holds(&view((0, 0), 1, false, 1)));
        assert_eq!(
            st.skip(&view((1, 0), 0, false, 0)),
            Skip::Held { first: true }
        );
        assert_eq!(
            st.skip(&view((1, 0), 0, false, 0)),
            Skip::Held { first: false }
        );
    }

    #[test]
    fn a_flag_is_released_by_a_peer_entry_a_response_the_idle_cap_or_the_absolute_cap() {
        // (a) Post-fault client work reached the destination.
        let mut st = flagged();
        st.skip(&view((1, 0), 0, false, 0));
        st.skip(&view((1, 1), 2, false, 1));
        st.note_post_fault_entry(0, 29);
        assert!(st.holds(&view((1, 0), 0, false, 0)), "an entry before the flag step");
        st.note_post_fault_entry(0, 31);
        assert!(!st.holds(&view((1, 0), 0, false, 0)));
        assert!(st.holds(&view((1, 1), 2, false, 1)), "the other destination still waits");
        assert!(st.active(), "the flag stays open elsewhere");
        assert_eq!(st.note_dispatch((1, 0), 0, false), Some(HeldRelease::PeerEntry));
        assert_eq!(st.note_dispatch((1, 0), 0, false), None, "counted once");

        // (b) A post-fault response.
        let c = st.completed(7, 40, true, &[]);
        assert_eq!(c.released, 1);
        assert!(!st.holds(&view((1, 1), 2, false, 1)));
        assert!(!st.active());
        assert_eq!(st.note_dispatch((1, 1), 2, false), Some(HeldRelease::Response));
        let c = st.completed(8, 41, false, &[]);
        assert_eq!(c.released, 0, "a pre-fault response releases nothing");

        // (c) The idle cap counts only idle steps.
        let mut st = flagged();
        st.skip(&view((1, 0), 0, false, 0));
        for s in 31..31 + EXPIRY_STEPS {
            assert_eq!(st.tick(s, false, &[1]).idle_capped, 0, "busy steps do not age it");
        }
        assert!(st.holds(&view((1, 0), 0, false, 0)));
        for s in 100..100 + EXPIRY_STEPS - 1 {
            assert_eq!(st.tick(s, true, &[]).idle_capped, 0);
        }
        assert_eq!(st.tick(100 + EXPIRY_STEPS - 1, true, &[]).idle_capped, 1);
        assert!(!st.holds(&view((1, 0), 0, false, 0)));
        assert_eq!(st.note_dispatch((1, 0), 0, false), Some(HeldRelease::IdleCap));

        // (d) The absolute cap ends a flag the busy run never let age.
        let mut st = flagged();
        st.skip(&view((1, 0), 0, false, 0));
        for s in 31..30 + FLAG_ABSOLUTE_CAP_STEPS {
            assert_eq!(st.tick(s, false, &[1]).abs_capped, 0);
        }
        assert_eq!(st.tick(30 + FLAG_ABSOLUTE_CAP_STEPS, false, &[1]).abs_capped, 1);
        assert!(!st.holds(&view((1, 0), 0, false, 0)));
        assert_eq!(st.note_dispatch((1, 0), 0, false), Some(HeldRelease::AbsCap));

        // A lifted step dispatches a record whose flag is still in force.
        let mut st = flagged();
        st.skip(&view((1, 0), 0, false, 0));
        assert_eq!(st.note_dispatch((1, 0), 0, true), Some(HeldRelease::Lift));
    }

    #[test]
    fn a_peer_entry_before_a_response_is_credited_to_the_peer_entry() {
        let mut st = flagged();
        st.skip(&view((1, 0), 0, false, 0));
        st.note_post_fault_entry(0, 35);
        st.completed(7, 36, true, &[]);
        assert_eq!(st.note_dispatch((1, 0), 0, false), Some(HeldRelease::PeerEntry));
        let mut st = flagged();
        st.skip(&view((1, 0), 0, false, 0));
        st.completed(7, 36, true, &[]);
        st.note_post_fault_entry(0, 37);
        assert_eq!(st.note_dispatch((1, 0), 0, false), Some(HeldRelease::Response));
    }

    #[test]
    fn the_caps_are_fixed() {
        assert_eq!(EXPIRY_STEPS, 64);
        assert_eq!(FLAG_ABSOLUTE_CAP_STEPS, 192);
    }
}
