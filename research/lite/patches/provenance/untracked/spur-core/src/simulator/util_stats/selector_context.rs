use super::{add_f64, enabled};
use crate::simulator::arm_selector::{Choice, Learner, SearchContext, SearchScope};
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};

const ROWS: usize = 3 * 4 * 4;

struct Counters {
    issued_runs: AtomicU64,
    completed_runs: AtomicU64,
    failed_runs: AtomicU64,
    unfilled_slot_fresh: AtomicU64,
    probe_draws: AtomicU64,
    coin_draws: AtomicU64,
    specialized_learner_draws: AtomicU64,
    shared_fallback_learner_draws: AtomicU64,
    sampled_runs: AtomicU64,
    scored_runs: AtomicU64,
    sampled_unscored_runs: AtomicU64,
    credited_runs: AtomicU64,
    learner_credits: AtomicU64,
    context_blocks_created: AtomicU64,
    pooled_context_blocks_created: AtomicU64,
    raw_observations_max: AtomicU64,
    pooled_raw_observations_max: AtomicU64,
    changed_argmax_runs: AtomicU64,
    tv_sum: AtomicU64,
    context_loss_sum: AtomicU64,
    shared_loss_sum: AtomicU64,
 }
impl Counters {
    const fn new() -> Self {
        Self {
            issued_runs: AtomicU64::new(0),
            completed_runs: AtomicU64::new(0),
            failed_runs: AtomicU64::new(0),
            unfilled_slot_fresh: AtomicU64::new(0),
            probe_draws: AtomicU64::new(0),
            coin_draws: AtomicU64::new(0),
            specialized_learner_draws: AtomicU64::new(0),
            shared_fallback_learner_draws: AtomicU64::new(0),
            sampled_runs: AtomicU64::new(0),
            scored_runs: AtomicU64::new(0),
            sampled_unscored_runs: AtomicU64::new(0),
            credited_runs: AtomicU64::new(0),
            learner_credits: AtomicU64::new(0),
            context_blocks_created: AtomicU64::new(0),
            pooled_context_blocks_created: AtomicU64::new(0),
            raw_observations_max: AtomicU64::new(0),
            pooled_raw_observations_max: AtomicU64::new(0),
            changed_argmax_runs: AtomicU64::new(0),
            tv_sum: AtomicU64::new(0),
            context_loss_sum: AtomicU64::new(0),
            shared_loss_sum: AtomicU64::new(0),
        }
    }
}
static ROW: [Counters; ROWS] = [const { Counters::new() }; ROWS];

fn row(scope: SearchScope, context: SearchContext, learner: Option<Learner>) -> &'static Counters {
    &ROW[(scope as usize * 4 + context as usize) * 4 + learner.map_or(3, Learner::index)]
}

pub fn reset() {
    for r in &ROW {
        r.issued_runs.store(0, Ordering::Relaxed);
        r.completed_runs.store(0, Ordering::Relaxed);
        r.failed_runs.store(0, Ordering::Relaxed);
        r.unfilled_slot_fresh.store(0, Ordering::Relaxed);
        r.probe_draws.store(0, Ordering::Relaxed);
        r.coin_draws.store(0, Ordering::Relaxed);
        r.specialized_learner_draws.store(0, Ordering::Relaxed);
        r.shared_fallback_learner_draws.store(0, Ordering::Relaxed);
        r.sampled_runs.store(0, Ordering::Relaxed);
        r.scored_runs.store(0, Ordering::Relaxed);
        r.sampled_unscored_runs.store(0, Ordering::Relaxed);
        r.credited_runs.store(0, Ordering::Relaxed);
        r.learner_credits.store(0, Ordering::Relaxed);
        r.context_blocks_created.store(0, Ordering::Relaxed);
        r.pooled_context_blocks_created.store(0, Ordering::Relaxed);
        r.raw_observations_max.store(0, Ordering::Relaxed);
        r.pooled_raw_observations_max.store(0, Ordering::Relaxed);
        r.changed_argmax_runs.store(0, Ordering::Relaxed);
        r.tv_sum.store(0, Ordering::Relaxed);
        r.context_loss_sum.store(0, Ordering::Relaxed);
        r.shared_loss_sum.store(0, Ordering::Relaxed);
    }
}

pub fn issued(scope: SearchScope, context: SearchContext, learner: Option<Learner>) {
    if enabled() { row(scope, context, learner).issued_runs.fetch_add(1, Ordering::Relaxed); }
}
pub fn finished(scope: SearchScope, context: SearchContext, learner: Option<Learner>, ok: bool, sampled: bool) {
    if !enabled() { return; }
    let r = row(scope, context, learner);
    if ok { r.completed_runs.fetch_add(1, Ordering::Relaxed); }
    else {
        r.failed_runs.fetch_add(1, Ordering::Relaxed);
        if sampled { r.sampled_unscored_runs.fetch_add(1, Ordering::Relaxed); }
    }
}
pub fn unfilled(learner: Option<Learner>) {
    if enabled() {
        row(SearchScope::Grid, SearchContext::Fresh, learner)
            .unfilled_slot_fresh.fetch_add(1, Ordering::Relaxed);
    }
}
pub fn draw(choice: &Choice, assigned: Option<Learner>, specialized: bool, tv: f64, changed: bool) {
    if !enabled() { return; }
    let r = row(choice.scope, choice.context, assigned);
    if assigned.is_none() { r.probe_draws.fetch_add(1, Ordering::Relaxed); }
    else if choice.learner.is_none() { r.coin_draws.fetch_add(1, Ordering::Relaxed); }
    else if specialized {
        r.specialized_learner_draws.fetch_add(1, Ordering::Relaxed);
        add_f64(&r.tv_sum, tv);
        r.changed_argmax_runs.fetch_add(changed as u64, Ordering::Relaxed);
        if choice.diagnostic.is_some() { r.sampled_runs.fetch_add(1, Ordering::Relaxed); }
    } else { r.shared_fallback_learner_draws.fetch_add(1, Ordering::Relaxed); }
}
pub fn scored(choice: &Choice, context_loss: f64, shared_loss: f64) {
    if !enabled() { return; }
    let r = row(choice.scope, choice.context, choice.learner);
    r.scored_runs.fetch_add(1, Ordering::Relaxed);
    add_f64(&r.context_loss_sum, context_loss);
    add_f64(&r.shared_loss_sum, shared_loss);
}
pub fn observed(choice: &Choice, assigned: Option<Learner>) {
    if enabled() { row(choice.scope, choice.context, assigned).credited_runs.fetch_add(1, Ordering::Relaxed); }
}
pub fn credit(choice: &Choice, learner: Learner, observations: u64, pooled: bool) {
    if !enabled() { return; }
    let r = row(choice.scope, choice.context, Some(learner));
    r.learner_credits.fetch_add(1, Ordering::Relaxed);
    r.raw_observations_max.fetch_max(observations, Ordering::Relaxed);
    if observations == 1 { r.context_blocks_created.fetch_add(1, Ordering::Relaxed); }
    if pooled {
        r.pooled_raw_observations_max.fetch_max(observations, Ordering::Relaxed);
        if observations == 1 { r.pooled_context_blocks_created.fetch_add(1, Ordering::Relaxed); }
    }
}

#[derive(Default, Clone, Serialize)]
pub struct Counts {
    pub issued_runs: u64,
    pub completed_runs: u64,
    pub failed_runs: u64,
    pub unfilled_slot_fresh: u64,
    pub probe_draws: u64,
    pub coin_draws: u64,
    pub specialized_learner_draws: u64,
    pub shared_fallback_learner_draws: u64,
    pub sampled_runs: u64,
    pub scored_runs: u64,
    pub sampled_unscored_runs: u64,
    pub credited_runs: u64,
    pub learner_credits: u64,
    pub context_blocks_created: u64,
    pub pooled_context_blocks_created: u64,
    pub raw_observations_max: u64,
    pub pooled_raw_observations_max: u64,
    pub changed_argmax_runs: u64,
    pub tv_sum: f64,
    pub context_loss_sum: f64,
    pub shared_loss_sum: f64,
 }
impl Counts {
    fn read(r: &Counters) -> Self {
        Self {
            issued_runs: r.issued_runs.load(Ordering::Relaxed),
            completed_runs: r.completed_runs.load(Ordering::Relaxed),
            failed_runs: r.failed_runs.load(Ordering::Relaxed),
            unfilled_slot_fresh: r.unfilled_slot_fresh.load(Ordering::Relaxed),
            probe_draws: r.probe_draws.load(Ordering::Relaxed),
            coin_draws: r.coin_draws.load(Ordering::Relaxed),
            specialized_learner_draws: r.specialized_learner_draws.load(Ordering::Relaxed),
            shared_fallback_learner_draws: r.shared_fallback_learner_draws.load(Ordering::Relaxed),
            sampled_runs: r.sampled_runs.load(Ordering::Relaxed),
            scored_runs: r.scored_runs.load(Ordering::Relaxed),
            sampled_unscored_runs: r.sampled_unscored_runs.load(Ordering::Relaxed),
            credited_runs: r.credited_runs.load(Ordering::Relaxed),
            learner_credits: r.learner_credits.load(Ordering::Relaxed),
            context_blocks_created: r.context_blocks_created.load(Ordering::Relaxed),
            pooled_context_blocks_created: r.pooled_context_blocks_created.load(Ordering::Relaxed),
            raw_observations_max: r.raw_observations_max.load(Ordering::Relaxed),
            pooled_raw_observations_max: r.pooled_raw_observations_max.load(Ordering::Relaxed),
            changed_argmax_runs: r.changed_argmax_runs.load(Ordering::Relaxed),
            tv_sum: f64::from_bits(r.tv_sum.load(Ordering::Relaxed)),
            context_loss_sum: f64::from_bits(r.context_loss_sum.load(Ordering::Relaxed)),
            shared_loss_sum: f64::from_bits(r.shared_loss_sum.load(Ordering::Relaxed)),
        }
    }
    fn add(&mut self, other: &Self) {
        self.issued_runs += other.issued_runs;
        self.completed_runs += other.completed_runs;
        self.failed_runs += other.failed_runs;
        self.unfilled_slot_fresh += other.unfilled_slot_fresh;
        self.probe_draws += other.probe_draws;
        self.coin_draws += other.coin_draws;
        self.specialized_learner_draws += other.specialized_learner_draws;
        self.shared_fallback_learner_draws += other.shared_fallback_learner_draws;
        self.sampled_runs += other.sampled_runs;
        self.scored_runs += other.scored_runs;
        self.sampled_unscored_runs += other.sampled_unscored_runs;
        self.credited_runs += other.credited_runs;
        self.learner_credits += other.learner_credits;
        self.context_blocks_created += other.context_blocks_created;
        self.pooled_context_blocks_created += other.pooled_context_blocks_created;
        self.raw_observations_max = self.raw_observations_max.max(other.raw_observations_max);
        self.pooled_raw_observations_max = self.pooled_raw_observations_max.max(other.pooled_raw_observations_max);
        self.changed_argmax_runs += other.changed_argmax_runs;
        self.tv_sum += other.tv_sum;
        self.context_loss_sum += other.context_loss_sum;
        self.shared_loss_sum += other.shared_loss_sum;
    }
}

#[derive(Default, Serialize)]
pub struct Breakdown {
    #[serde(flatten)]
    pub counts: Counts,
    pub learners: BTreeMap<&'static str, Counts>,
}
#[derive(Default, Serialize)]
pub struct ScopeStats {
    #[serde(flatten)]
    pub counts: Counts,
    pub contexts: BTreeMap<&'static str, Breakdown>,
    pub learners: BTreeMap<&'static str, Counts>,
}
#[derive(Serialize)]
pub struct Stats {
    #[serde(flatten)]
    pub counts: Counts,
    pub scopes: BTreeMap<&'static str, ScopeStats>,
    pub context_block_bytes: usize,
    pub cell_learner_bytes: usize,
    pub choice_bytes: usize,
    pub attribution_bytes: usize,
}
impl Stats {
    pub fn read() -> Self {
        let mut counts = Counts::default();
        let mut scopes = BTreeMap::new();
        for (si, scope) in ["grid", "aos", "other"].into_iter().enumerate() {
            let mut stats = ScopeStats::default();
            for (ci, context) in ["fresh", "plan_reuse", "prefix_replay", "tape_mutation"].into_iter().enumerate() {
                let mut breakdown = Breakdown::default();
                for (li, learner) in ["a", "b", "c", "none"].into_iter().enumerate() {
                    let c = Counts::read(&ROW[(si * 4 + ci) * 4 + li]);
                    breakdown.counts.add(&c);
                    stats.learners.entry(learner).or_default().add(&c);
                    breakdown.learners.insert(learner, c);
                }
                stats.counts.add(&breakdown.counts);
                stats.contexts.insert(context, breakdown);
            }
            counts.add(&stats.counts);
            scopes.insert(scope, stats);
        }
        let (context_block_bytes, cell_learner_bytes, choice_bytes) = crate::simulator::arm_selector::context_layout();
        Self { counts, scopes, context_block_bytes, cell_learner_bytes, choice_bytes,
            attribution_bytes: std::mem::size_of::<crate::simulator::explorer::RunAttribution>() }
    }
}
