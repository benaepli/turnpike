use crate::simulator::util_stats;
use serde_json::{Map, Value};
use std::sync::atomic::{AtomicU64, Ordering};

const NAMES: [&str; 24] = [
    "active_runs",
    "active_eight_steps",
    "runs_reaching_change_point",
    "change_points_reached",
    "no_chain_points",
    "repeat_demotions",
    "root_allocations",
    "missing_ancestry_roots",
    "inherited_cross_node_sends",
    "eligible_tournaments",
    "multi_chain_samples",
    "authority_decisions",
    "stock_non_executable",
    "singleton_excluded",
    "proportional_excluded",
    "same_chain_ties",
    "choice_changed_before_preferences",
    "choice_changed_after_preferences",
    "fresh_first_overwrites",
    "pair_order_overwrites",
    "inert_short_cap",
    "source_exhausted_runs",
    "timer_resumed_roots",
    "timer_unclaimed_roots",
];
static COUNTERS: [AtomicU64; 24] = [const { AtomicU64::new(0) }; 24];
static SAMPLE_CHAIN_COUNTS: [AtomicU64; 3] = [const { AtomicU64::new(0) }; 3];
static DELAYS: [AtomicU64; 16] = [const { AtomicU64::new(0) }; 16];
static REMAINING: [AtomicU64; 16] = [const { AtomicU64::new(0) }; 16];
const ARMS: usize = 6;
// Population, arm, readiness, length. The final bucket includes longer stretches.
static LENGTHS: [AtomicU64; 2 * ARMS * 4 * 32] = [const { AtomicU64::new(0) }; 2 * ARMS * 4 * 32];
static CENSORED: [AtomicU64; 2 * ARMS * 4 * 32] = [const { AtomicU64::new(0) }; 2 * ARMS * 4 * 32];
static EXPOSURE: [AtomicU64; 2 * ARMS * 4 * 2] = [const { AtomicU64::new(0) }; 2 * ARMS * 4 * 2];
static QUALIFIED: [AtomicU64; 2 * ARMS] = [const { AtomicU64::new(0) }; 2 * ARMS];
static MAX_DEMOTED: AtomicU64 = AtomicU64::new(0);
static MAX_RUN_BYTES: AtomicU64 = AtomicU64::new(0);

pub(crate) fn count(index: usize) {
    if util_stats::enabled() {
        COUNTERS[index].fetch_add(1, Ordering::Relaxed);
    }
}
pub(crate) fn record_sample_chains(any: bool, multiple: bool) {
    if util_stats::enabled() {
        let bin = if multiple { 2 } else { usize::from(any) };
        SAMPLE_CHAIN_COUNTS[bin].fetch_add(1, Ordering::Relaxed);
    }
}
fn add(index: usize, n: u64) {
    if util_stats::enabled() {
        COUNTERS[index].fetch_add(n, Ordering::Relaxed);
    }
}
fn bucket(n: u32) -> usize {
    if n == 0 {
        0
    } else {
        (32 - n.leading_zeros()).min(15) as usize
    }
}
fn mix(mut x: u64) -> u64 {
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^ (x >> 31)
}
fn below(seed: &mut u64, n: u64) -> u64 {
    let threshold = n.wrapping_neg() % n;
    loop {
        *seed = seed.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let value = mix(*seed);
        if value >= threshold {
            return value % n;
        }
    }
}

#[derive(Debug, Clone)]
pub struct ChainState {
    next_root: u64,
    missing: u64,
    sends: u64,
    seed: u64,
    cap: i32,
    exhausted: Option<i32>,
    active_step: Option<i32>,
    pub active: bool,
    prefix_child: bool,
    plan_child: bool,
    observing: bool,
    observed_step: bool,
    arm: usize,
    points: [i32; 2],
    point_cursor: usize,
    demoted: [u64; 2],
    demoted_len: usize,
    last_executed: u64,
    stretch_chain: u64,
    stretch_len: u32,
    stretch_ready: usize,
    suffix_steps: u32,
    lengths: [u32; 128],
    dispatches: [u32; 4],
    timers: [u32; 4],
}
impl Default for ChainState {
    fn default() -> Self {
        Self {
            next_root: 0,
            missing: 0,
            sends: 0,
            seed: 0,
            cap: 0,
            exhausted: None,
            active_step: None,
            active: false,
            prefix_child: false,
            plan_child: false,
            observing: false,
            observed_step: false,
            arm: 0,
            points: [0; 2],
            point_cursor: 0,
            demoted: [0; 2],
            demoted_len: 0,
            last_executed: 0,
            stretch_chain: 0,
            stretch_len: 0,
            stretch_ready: 0,
            suffix_steps: 0,
            lengths: [0; 128],
            dispatches: [0; 4],
            timers: [0; 4],
        }
    }
}
impl ChainState {
    pub fn configure(
        &mut self,
        seed: u64,
        cap: i32,
        prefix_child: bool,
        plan_child: bool,
        arm: i32,
    ) {
        self.seed = seed;
        self.cap = cap;
        self.prefix_child = prefix_child;
        self.plan_child = plan_child;
        self.arm = if (0..5).contains(&arm) {
            arm as usize
        } else {
            5
        };
    }
    pub fn set_cap(&mut self, cap: i32) {
        self.cap = cap;
    }
    pub fn root(&mut self) -> u64 {
        self.next_root += 1;
        self.next_root
    }
    pub fn missing_root(&mut self) -> u64 {
        self.missing += 1;
        self.root()
    }
    pub fn inherited_send(&mut self) {
        self.sends += 1;
    }
    pub fn note_exhaustion(&mut self, step: i32, exhausted: bool) {
        if self.prefix_child && exhausted && self.exhausted.is_none() {
            self.exhausted = Some(step);
            count(21);
        }
    }
    pub fn before_step(&mut self, step: i32, exhausted: bool, signal: bool) {
        if self.observing && !self.observed_step {
            self.end_stretch();
        }
        self.observed_step = false;
        self.note_exhaustion(step, exhausted);
        if self.prefix_child && !self.active && exhausted && signal && self.active_step.is_none() {
            self.active_step = Some(step);
            let remaining = self.cap.saturating_sub(step);
            if remaining < 3 {
                count(20);
                return;
            }
            self.active = true;
            self.observing = true;
            count(0);
            if util_stats::enabled() {
                DELAYS[bucket((step - self.exhausted.unwrap()).max(0) as u32)]
                    .fetch_add(1, Ordering::Relaxed);
                REMAINING[bucket(remaining as u32)].fetch_add(1, Ordering::Relaxed);
            }
            let mut private = self.seed ^ 0x4638_039e_12f0_abc7;
            let future = remaining - 1;
            let a = below(&mut private, future as u64) as i32;
            let b0 = below(&mut private, (future - 1) as u64) as i32;
            let b = b0 + i32::from(b0 >= a);
            self.points = [step + 1 + a.min(b), step + 1 + a.max(b)];
        }
        if self.plan_child && signal {
            self.observing = true;
        }
        if self.observing {
            self.suffix_steps += 1;
        }
        if self.active && self.point_cursor < 2 && step >= self.points[self.point_cursor] {
            self.point_cursor += 1;
            count(3);
            if self.point_cursor == 1 {
                count(2);
            }
            if self.last_executed == 0 {
                count(4);
            } else if self.demoted[..self.demoted_len].contains(&self.last_executed) {
                count(5);
            } else {
                self.demoted[self.demoted_len] = self.last_executed;
                self.demoted_len += 1;
            }
        }
    }
    pub fn key(&self, chain: u64) -> (u8, u64, u64) {
        let tier = match self.demoted[..self.demoted_len]
            .iter()
            .position(|&id| id == chain)
        {
            Some(i) => 1 - i as u8,
            None => 2,
        };
        (tier, mix(self.seed ^ mix(chain)), chain)
    }
    fn end_stretch(&mut self) {
        if self.stretch_len > 0 {
            let idx = self.stretch_ready * 32 + self.stretch_len.min(32) as usize - 1;
            self.lengths[idx] += 1;
        }
        self.stretch_len = 0;
        self.stretch_chain = 0;
    }
    pub fn executed(&mut self, chain: u64) {
        self.last_executed = chain;
    }
    pub fn dispatch(&mut self, chain: Option<u64>, timer: bool, ready: usize) {
        if let Some(id) = chain {
            self.executed(id);
        }
        if !self.observing {
            return;
        }
        self.observed_step = true;
        self.dispatches[ready] += 1;
        self.timers[ready] += u32::from(timer);
        if let Some(id) = chain {
            if self.stretch_chain != id {
                self.end_stretch();
                self.stretch_chain = id;
                self.stretch_ready = ready;
            }
            self.stretch_len += 1;
        } else {
            self.end_stretch();
        }
    }
    pub fn finish(&mut self) {
        add(6, self.next_root);
        add(7, self.missing);
        add(8, self.sends);
        if self.active && self.suffix_steps >= 8 {
            count(1);
        }
        if !util_stats::enabled() {
            return;
        }
        MAX_DEMOTED.fetch_max(self.demoted_len as u64, Ordering::Relaxed);
        MAX_RUN_BYTES.fetch_max(std::mem::size_of::<Self>() as u64, Ordering::Relaxed);
        if !self.observing || self.dispatches.iter().sum::<u32>() < 8 {
            return;
        }
        let population = usize::from(!self.active);
        let cell = population * ARMS + self.arm;
        QUALIFIED[cell].fetch_add(1, Ordering::Relaxed);
        if !self.observed_step {
            self.end_stretch();
        }
        if self.stretch_len > 0 {
            let idx = self.stretch_ready * 32 + self.stretch_len.min(32) as usize - 1;
            CENSORED[cell * 128 + idx].fetch_add(1, Ordering::Relaxed);
        }
        self.end_stretch();
        for (i, &n) in self.lengths.iter().enumerate() {
            LENGTHS[cell * 128 + i].fetch_add(n as u64, Ordering::Relaxed);
        }
        for ready in 0..4 {
            EXPOSURE[cell * 8 + ready * 2]
                .fetch_add(self.dispatches[ready] as u64, Ordering::Relaxed);
            EXPOSURE[cell * 8 + ready * 2 + 1]
                .fetch_add(self.timers[ready] as u64, Ordering::Relaxed);
        }
    }
}

pub(crate) fn reset() {
    for counters in [
        &COUNTERS[..],
        &SAMPLE_CHAIN_COUNTS,
        &DELAYS,
        &REMAINING,
        &LENGTHS,
        &CENSORED,
        &EXPOSURE,
        &QUALIFIED,
    ] {
        for counter in counters {
            counter.store(0, Ordering::Relaxed);
        }
    }
    MAX_DEMOTED.store(0, Ordering::Relaxed);
    MAX_RUN_BYTES.store(0, Ordering::Relaxed);
}

pub(crate) fn snapshot() -> Value {
    let mut out = Map::new();
    for (name, counter) in NAMES.iter().zip(&COUNTERS) {
        out.insert((*name).into(), counter.load(Ordering::Relaxed).into());
    }
    use crate::simulator::core::{Record, Runnable, partition::QueuedMessage};
    use crate::simulator::hash_utils::NoHashing;
    out.insert(
        "record_bytes".into(),
        std::mem::size_of::<Record<NoHashing>>().into(),
    );
    out.insert(
        "runnable_bytes".into(),
        std::mem::size_of::<Runnable<NoHashing>>().into(),
    );
    out.insert(
        "partition_message_bytes".into(),
        std::mem::size_of::<QueuedMessage<NoHashing>>().into(),
    );
    out.insert(
        "sampled_executable_chain_count".into(),
        Value::Object(
            ["zero", "one", "two_or_more"]
                .iter()
                .zip(&SAMPLE_CHAIN_COUNTS)
                .map(|(name, count)| ((*name).into(), count.load(Ordering::Relaxed).into()))
                .collect(),
        ),
    );
    out.insert(
        "run_storage_bytes".into(),
        (std::mem::size_of::<ChainState>() as u64).into(),
    );
    out.insert("run_dynamic_capacity_bytes".into(), 0.into());
    out.insert(
        "max_run_owned_bytes".into(),
        MAX_RUN_BYTES.load(Ordering::Relaxed).into(),
    );
    out.insert(
        "max_retained_demotion_entries".into(),
        MAX_DEMOTED.load(Ordering::Relaxed).into(),
    );
    for (name, bins) in [
        ("activation_delay_log2", &DELAYS),
        ("remaining_cap_log2", &REMAINING),
    ] {
        let map: Map<String, Value> = bins
            .iter()
            .enumerate()
            .map(|(i, n)| (i.to_string(), n.load(Ordering::Relaxed).into()))
            .collect();
        out.insert(name.into(), Value::Object(map));
    }
    for (p, name) in ["prefix", "plan_only"].iter().enumerate() {
        let mut arms = Map::new();
        for arm in 0..ARMS {
            let cell = p * ARMS + arm;
            let mut strata = Map::new();
            strata.insert(
                "qualified_runs".into(),
                QUALIFIED[cell].load(Ordering::Relaxed).into(),
            );
            for ready in 0..4 {
                let mut item = Map::new();
                item.insert(
                    "dispatches".into(),
                    EXPOSURE[cell * 8 + ready * 2]
                        .load(Ordering::Relaxed)
                        .into(),
                );
                item.insert(
                    "timers".into(),
                    EXPOSURE[cell * 8 + ready * 2 + 1]
                        .load(Ordering::Relaxed)
                        .into(),
                );
                for (label, histogram) in [
                    ("lengths_including_censored", &LENGTHS),
                    ("censored", &CENSORED),
                ] {
                    let bins: Map<String, Value> = (0..32)
                        .map(|i| {
                            (
                                (i + 1).to_string(),
                                histogram[cell * 128 + ready * 32 + i]
                                    .load(Ordering::Relaxed)
                                    .into(),
                            )
                        })
                        .collect();
                    item.insert(label.into(), Value::Object(bins));
                }
                strata.insert(ready.to_string(), Value::Object(item));
            }
            arms.insert(arm.to_string(), Value::Object(strata));
        }
        out.insert((*name).into(), Value::Object(arms));
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn activation_roots_and_fixed_future_points() {
        let _serial = crate::simulator::config_override::exclusive_session();
        let mut c = ChainState::default();
        c.configure(42, 100, true, false, 0);
        assert_ne!(c.root(), c.root());
        c.before_step(10, false, true);
        assert!(!c.active);
        c.before_step(12, true, false);
        assert!(!c.active);
        c.before_step(15, true, true);
        assert!(c.active);
        assert!(15 < c.points[0] && c.points[0] < c.points[1] && c.points[1] < 100);
        let original = c.points;
        c.before_step(16, true, true);
        assert_eq!(original, c.points);
        for prefix in [false, true] {
            let mut short = ChainState::default();
            short.configure(0, 12, prefix, !prefix, 0);
            short.before_step(10, true, true);
            assert!(!short.active);
        }
        assert!(std::mem::size_of::<ChainState>() <= 1024);
        println!(
            "ChainState={} dynamic=0 demotion_capacity=2",
            std::mem::size_of::<ChainState>()
        );
    }
    #[test]
    fn demotions_and_intervening_dispatches() {
        let _serial = crate::simulator::config_override::exclusive_session();
        let mut c = ChainState::default();
        c.configure(9, 100, true, false, 0);
        c.before_step(0, true, true);
        c.dispatch(Some(1), false, 0);
        c.before_step(c.points[0], true, true);
        assert!(c.key(1) < c.key(2));
        c.dispatch(Some(2), false, 0);
        c.dispatch(None, true, 1);
        c.before_step(c.points[1], true, true);
        assert!(c.key(2) < c.key(1));
        assert!(c.key(1) < c.key(3));
        assert_eq!(c.demoted_len, 2);
        assert_eq!(c.stretch_len, 0);
    }
    #[test]
    fn minimum_cap_repeat_demotions_and_empty_points() {
        let _serial = crate::simulator::config_override::exclusive_session();
        let mut c = ChainState::default();
        c.configure(4, 13, true, false, 0);
        c.before_step(10, true, true);
        assert!(c.active);
        assert_eq!(c.points, [11, 12]);
        c.before_step(11, true, true);
        assert_eq!(c.demoted_len, 0);
        c.dispatch(Some(7), false, 0);
        c.before_step(12, true, true);
        assert_eq!(c.demoted_len, 1);
        let mut repeat = ChainState::default();
        repeat.configure(9, 100, true, false, 0);
        repeat.before_step(0, true, true);
        repeat.dispatch(Some(7), false, 0);
        repeat.before_step(repeat.points[0], true, true);
        let order = [repeat.key(7), repeat.key(8)];
        repeat.before_step(repeat.points[1], true, true);
        assert_eq!(repeat.demoted_len, 1);
        assert_eq!(order, [repeat.key(7), repeat.key(8)]);
    }

    #[test]
    fn exports_exclude_short_dispatch_runs_include_censored_and_reset() {
        let _serial = crate::simulator::config_override::exclusive_session();
        util_stats::set_enabled(true);
        record_sample_chains(false, false);
        record_sample_chains(true, false);
        record_sample_chains(true, true);
        assert_eq!(
            snapshot()["sampled_executable_chain_count"],
            serde_json::json!({"zero": 1, "one": 1, "two_or_more": 1})
        );
        let mut short = ChainState::default();
        short.configure(4, 100, true, false, 0);
        for step in 0..20 {
            short.before_step(step, true, true);
        }
        short.dispatch(Some(1), false, 0);
        short.finish();
        assert_eq!(snapshot()["prefix"]["0"]["qualified_runs"], 0);
        let mut c = ChainState::default();
        c.configure(9, 100, false, true, 0);
        for step in 0..8 {
            c.before_step(step, false, true);
            c.dispatch(Some(1), false, 3);
        }
        c.finish();
        let s = snapshot();
        assert_eq!(s["plan_only"]["0"]["qualified_runs"], 1);
        assert_eq!(
            s["plan_only"]["0"]["3"]["lengths_including_censored"]["8"],
            1
        );
        assert_eq!(s["plan_only"]["0"]["3"]["censored"]["8"], 1);
        assert_eq!(s["plan_only"]["0"]["3"]["dispatches"], 8);
        let rendered = util_stats::render_snapshot(&util_stats::snapshot()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&rendered).unwrap()["replay_chain_pct"],
            s
        );
        util_stats::set_enabled(false);
        util_stats::set_enabled(true);
        let reset = snapshot();
        assert_eq!(reset["active_runs"], 0);
        assert_eq!(reset["sampled_executable_chain_count"]["two_or_more"], 0);
        assert_eq!(reset["plan_only"]["0"]["qualified_runs"], 0);
        assert_eq!(
            reset["plan_only"]["0"]["3"]["lengths_including_censored"]["8"],
            0
        );
        util_stats::set_enabled(false);
    }
}
