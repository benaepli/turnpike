//! Per-cell selection of the mechanism arm set, learned from the rarity of
//! the delivery contexts a run reaches after a recover.
//!
//! Every run carries one direction on each of five mechanism axes (the
//! `ArmSet`). Most runs take the directions the run id's coins name. The
//! treated half of the runs - drawn by id under a salt of its own, never a
//! probe of either kind - takes a learned arm set instead: one discounted
//! Beta posterior per direction is kept for every cell, a cell being one
//! campaign arm at one configuration, and the treated run samples each axis
//! independently. The sample on an axis draws a Beta value per direction
//! and picks a direction with probability proportional to the coin's share
//! of that direction times the drawn value, so with equal posteriors the
//! expected share of every direction is close to the coin's, and the selector
//! departs from the coins only on evidence. A cell below its warmup count
//! hands the treated run its coin arm set.
//!
//! The reward is read on both halves at run end. Once a run has applied a
//! recover, every message entry pushes a packed delivery-context key; the
//! run's score is the mean over its distinct keys of one over one plus the
//! cell's decayed count of that key, so a run is rewarded for reaching
//! contexts the cell has rarely reached. The reward is one when the score
//! beats the cell's running average of scores, and it credits the five
//! directions the run carried. Both halves feed the learner; the treated
//! half only differs in how its directions are drawn.
//!
//! The selector's own draws come from a generator seeded from the run's
//! schedule seed under a salt of its own, so the run's schedule stream is
//! untouched and an untreated run draws exactly what it would without the
//! selector. A treated run's arm set depends on the learner's state at draw
//! time, so it is not a function of the run id alone; the run's tag records
//! the arms it ran under.

use crate::simulator::rng::derive_seed;
use crate::simulator::run_cap;
use crate::simulator::run_phase;
use crate::simulator::run_variant::{AXES, AXIS_START, ArmSet, DIRECTIONS};
use crate::simulator::timer_context;
use crate::simulator::util_stats;
use dashmap::DashMap;
use rand::Rng;
use rand::SeedableRng;
use rand::rngs::SmallRng;
use rand_distr::{Beta, Distribution};
use std::collections::HashMap;
use std::sync::LazyLock;

/// Salt for the treated half. Distinct from every other split of a session.
pub const SELECTOR_SALT: u64 = 0x_4152_4D53_454C_4354; // "ARMSELCT"

/// Salt for the selector's own generator, derived per run from the schedule
/// seed so the draw is reproducible given the learner's state.
const DRAW_SALT: u64 = 0x_4152_4D44_5241_5753; // "ARMDRAWS"

/// Per-observation discount on the posteriors of the directions a run
/// carried, so a cell follows its recent reward rate rather than its whole
/// history.
pub const DISCOUNT: f64 = 0.995;

/// Observations a cell needs before a treated run draws from its
/// posteriors; below it the treated run takes its coin arm set.
pub const WARMUP_OBSERVATIONS: u64 = 24;

/// Per-observation decay of a cell's per-key counts.
const KEY_DECAY: f64 = 0.999;

/// Weight of the newest score in a cell's running average.
const EMA_WEIGHT: f64 = 0.01;

/// A cell: the campaign arm index and the configuration index the run is
/// attributed to.
pub type Cell = (i32, i32);

/// Whether this run takes a learned arm set. Probes of either kind are
/// never treated: run-cap probes feed the length learners and timer-context
/// probes must run unsteered.
pub fn is_treated(run_id: i64) -> bool {
    !run_cap::is_probe(run_id)
        && timer_context::run_mode(run_id) != timer_context::RunMode::Probe
        && run_phase::salted_phase(run_id, SELECTOR_SALT, 2) == 1
}

/// One cell's learner state.
struct CellLearner {
    /// Discounted reward and non-reward mass per direction.
    alpha: [f64; DIRECTIONS],
    beta: [f64; DIRECTIONS],
    /// Runs observed in this cell.
    observations: u64,
    /// Per key: the decayed count as of the observation index it was last
    /// touched at, and that index. Decay is applied lazily on read.
    keys: HashMap<u32, (f64, u64)>,
    /// Running average of scores; None until the first observation.
    ema: Option<f64>,
}

impl CellLearner {
    fn new() -> Self {
        Self {
            alpha: [0.0; DIRECTIONS],
            beta: [0.0; DIRECTIONS],
            observations: 0,
            keys: HashMap::new(),
            ema: None,
        }
    }

    /// The decayed count of `key` as of now.
    fn count(&self, key: u32) -> f64 {
        match self.keys.get(&key) {
            Some(&(c, at)) => c * KEY_DECAY.powi((self.observations - at) as i32),
            None => 0.0,
        }
    }

    /// The posterior mean of a direction under a flat prior.
    fn mean(&self, d: usize) -> f64 {
        (1.0 + self.alpha[d]) / (2.0 + self.alpha[d] + self.beta[d])
    }

    /// The direction of axis `a` with the highest posterior mean; the
    /// lowest index wins a tie.
    fn leader(&self, a: usize) -> usize {
        let mut best = AXIS_START[a];
        for d in AXIS_START[a] + 1..AXIS_START[a + 1] {
            if self.mean(d) > self.mean(best) {
                best = d;
            }
        }
        best
    }

    /// Sample one direction of axis `a`: a Beta draw per direction, the
    /// pick proportional to the coin share times the draw.
    fn sample_axis(&self, a: usize, rng: &mut SmallRng) -> usize {
        let range = AXIS_START[a]..AXIS_START[a + 1];
        let mut weights = [0.0f64; 3];
        let mut total = 0.0;
        for (slot, d) in range.clone().enumerate() {
            let theta = Beta::new(1.0 + self.alpha[d], 1.0 + self.beta[d])
                .map(|b| b.sample(rng))
                .unwrap_or(0.5);
            weights[slot] = ArmSet::coin_probability(d) * theta;
            total += weights[slot];
        }
        if total <= 0.0 {
            return AXIS_START[a];
        }
        let mut u = rng.random::<f64>() * total;
        for (slot, d) in range.clone().enumerate() {
            u -= weights[slot];
            if u < 0.0 {
                return d;
            }
        }
        AXIS_START[a + 1] - 1
    }
}

static CELLS: LazyLock<DashMap<Cell, CellLearner>> = LazyLock::new(DashMap::new);

/// The arm set a run takes. An untreated run takes its coins; a treated run
/// draws from its cell's posteriors once the cell is past warmup. The draw
/// reads nothing from the run's schedule stream.
pub fn choose(run_id: i64, schedule_seed: u64, cell: Cell) -> ArmSet {
    let coins = ArmSet::coins(run_id);
    if !is_treated(run_id) {
        return coins;
    }
    let drawn = CELLS.get(&cell).and_then(|learner| {
        if learner.observations < WARMUP_OBSERVATIONS {
            return None;
        }
        let mut rng = SmallRng::seed_from_u64(derive_seed(schedule_seed, run_id, DRAW_SALT));
        let mut directions = [0usize; AXES];
        let mut agreements = 0u64;
        for (a, slot) in directions.iter_mut().enumerate() {
            *slot = learner.sample_axis(a, &mut rng);
            agreements += (*slot == learner.leader(a)) as u64;
        }
        Some((ArmSet::from_directions(directions), agreements))
    });
    match drawn {
        Some((arms, agreements)) => {
            util_stats::record_arm_selector_treated_run(Some(&arms), &coins, agreements);
            arms
        }
        None => {
            util_stats::record_arm_selector_treated_run(None, &coins, 0);
            coins
        }
    }
}

/// The context of one message entry after a recover, packed: the
/// destination node, the handler's entry vertex, whether the sending
/// incarnation is dead, whether the destination has restarted, and how many
/// entries the destination has taken since its restart, bucketed.
pub fn delivery_key(
    dest: usize,
    handler: usize,
    origin_dead: bool,
    dest_restarted: bool,
    entries_since_restart: u32,
) -> u32 {
    let bucket = match entries_since_restart {
        0 => 0u32,
        1..=3 => 1,
        4..=15 => 2,
        _ => 3,
    };
    ((dest as u32 & 0xFF) << 24)
        | ((handler as u32 & 0xF_FFFF) << 4)
        | ((origin_dead as u32) << 3)
        | ((dest_restarted as u32) << 2)
        | bucket
}

/// Fold one finished run into its cell. `keys` are the run's post-recover
/// delivery contexts in entry order; the score reads their distinct set.
pub fn observe(cell: Cell, treated: bool, arms: &ArmSet, keys: &mut Vec<u32>) {
    keys.sort_unstable();
    keys.dedup();
    let mut learner = CELLS.entry(cell).or_insert_with(|| {
        util_stats::record_arm_selector_cell_created();
        CellLearner::new()
    });
    let score = if keys.is_empty() {
        0.0
    } else {
        keys.iter().map(|&k| 1.0 / (1.0 + learner.count(k))).sum::<f64>() / keys.len() as f64
    };
    let reward = learner.ema.is_some_and(|ema| score > ema);
    let now = learner.observations;
    for &k in keys.iter() {
        let count = learner.count(k);
        if learner.keys.insert(k, (count + 1.0, now)).is_none() {
            util_stats::record_arm_selector_key_created();
        }
    }
    learner.ema = Some(match learner.ema {
        Some(ema) => ema + EMA_WEIGHT * (score - ema),
        None => score,
    });
    learner.observations += 1;
    let r = reward as u8 as f64;
    for d in arms.directions() {
        learner.alpha[d] = DISCOUNT * learner.alpha[d] + r;
        learner.beta[d] = DISCOUNT * learner.beta[d] + (1.0 - r);
    }
    drop(learner);
    util_stats::record_arm_selector_observation(treated, arms, reward, keys.is_empty(), cell.0);
}

/// Clear every cell so explorer sessions in one process do not share
/// learners.
pub fn reset() {
    CELLS.clear();
    util_stats::reset_arm_selector_gauges();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::simulator::config_override;
    use crate::simulator::fault_timing;
    use crate::simulator::rng::StreamRng;
    use crate::simulator::run_variant::{COMBINATIONS, CrashArm};
    use rand::RngCore;

    /// Counts draws so a test can assert a path consumed none.
    struct CountingRng {
        inner: SmallRng,
        draws: u64,
    }

    impl RngCore for CountingRng {
        fn next_u32(&mut self) -> u32 {
            self.draws += 1;
            self.inner.next_u32()
        }
        fn next_u64(&mut self) -> u64 {
            self.draws += 1;
            self.inner.next_u64()
        }
        fn fill_bytes(&mut self, dst: &mut [u8]) {
            self.draws += 1;
            self.inner.fill_bytes(dst)
        }
    }

    impl StreamRng for CountingRng {}

    fn id_where(pred: impl Fn(i64) -> bool) -> i64 {
        (0..1_000_000i64).find(|&id| pred(id)).expect("every half is reachable")
    }

    fn feed(cell: Cell, n: usize, arms: &ArmSet, keys: &[u32]) {
        for _ in 0..n {
            observe(cell, false, arms, &mut keys.to_vec());
        }
    }

    #[test]
    fn the_treated_half_spares_every_probe_and_leaves_a_contrast() {
        let n = 64_000i64;
        let treated = (0..n).filter(|&id| is_treated(id)).count();
        assert!(treated > 20_000 && treated < 40_000, "treated {treated} of {n}");
        for id in 0..n {
            let probe = run_cap::is_probe(id)
                || timer_context::run_mode(id) == timer_context::RunMode::Probe;
            assert!(!(probe && is_treated(id)), "run {id}: a probe is treated");
        }
    }

    #[test]
    fn neither_half_touches_the_schedule_stream_and_the_draw_is_reproducible() {
        let _serial = config_override::exclusive_session();
        fault_timing::reset();
        reset();
        let cell = (7, 3);
        let treated = id_where(is_treated);
        let untreated = id_where(|id| !is_treated(id) && !run_cap::is_probe(id));
        let schedule = CountingRng {
            inner: SmallRng::seed_from_u64(1),
            draws: 0,
        };
        assert_eq!(choose(untreated, 5, cell), ArmSet::coins(untreated));
        assert_eq!(choose(treated, 5, cell), ArmSet::coins(treated), "below warmup: coins");
        feed(cell, WARMUP_OBSERVATIONS as usize, &ArmSet::default(), &[1, 2]);
        let first = choose(treated, 5, cell);
        assert_eq!(choose(treated, 5, cell), first, "the same seed and state draw alike");
        assert_eq!(choose(untreated, 5, cell), ArmSet::coins(untreated));
        assert_eq!(schedule.draws, 0, "the selector must not read the run's stream");
        reset();
    }

    #[test]
    fn flat_posteriors_draw_the_coin_shares_and_evidence_moves_them() {
        let _serial = config_override::exclusive_session();
        fault_timing::reset();
        reset();
        let cell = (1, 1);
        // Every combination once with no reward, so the posteriors within
        // an axis are equal and the draw can only follow the coins.
        for i in 0..COMBINATIONS {
            observe(cell, false, &ArmSet::from_index(i), &mut Vec::new());
        }
        let mut placed = 0usize;
        let mut stock = 0usize;
        let mut hold = 0usize;
        let mut n = 0usize;
        for id in 0..200_000i64 {
            if !is_treated(id) {
                continue;
            }
            let arms = choose(id, 11, cell);
            placed += arms.placed() as usize;
            stock += (arms.crash == CrashArm::Stock) as usize;
            hold += (arms.request == crate::simulator::client_anchor::Arm::Hold) as usize;
            n += 1;
        }
        // The pick is proportional to the coin times a Beta draw, so with
        // equal posteriors the expected share is the coin's up to the
        // spread of the draws, which inflates the smallest coin a little.
        let want_placed = ArmSet::coin_probability(1) + ArmSet::coin_probability(2);
        let got_placed = placed as f64 / n as f64;
        let got_stock = stock as f64 / n as f64;
        assert!(
            got_placed > want_placed - 0.1 && got_placed < want_placed + 0.02,
            "equal posteriors placed {got_placed} against the coin {want_placed}"
        );
        assert!(got_stock < 0.2, "equal posteriors stock {got_stock}");
        let got_hold = hold as f64 / n as f64;
        assert!((got_hold - 0.5).abs() < 0.08, "equal posteriors hold {got_hold}");
        eprintln!("equal posteriors: placed {got_placed} (coin {want_placed}), hold {got_hold}");

        // Reward only runs that took stock crashes and the rush: the cell's
        // posteriors then favour those directions over the coin.
        reset();
        let rewarded = ArmSet {
            crash: CrashArm::Stock,
            request: crate::simulator::client_anchor::Arm::Rush,
            ..ArmSet::default()
        };
        let mut key = 100u32;
        for i in 0..400 {
            let arms = if i % 2 == 0 { rewarded } else { ArmSet::from_index(71) };
            // A fresh key every time on the rewarded set, a repeated key on
            // the other, so only the rewarded set beats the running mean.
            let keys: Vec<u32> = if i % 2 == 0 {
                key += 1;
                vec![key]
            } else {
                vec![1]
            };
            observe(cell, false, &arms, &mut keys.clone());
        }
        let mut stock = 0usize;
        let mut rush = 0usize;
        let mut m = 0usize;
        for id in 0..100_000i64 {
            if !is_treated(id) {
                continue;
            }
            let arms = choose(id, 11, cell);
            stock += (arms.crash == CrashArm::Stock) as usize;
            rush += (arms.request == crate::simulator::client_anchor::Arm::Rush) as usize;
            m += 1;
        }
        let stock_share = stock as f64 / m as f64;
        let rush_share = rush as f64 / m as f64;
        assert!(stock_share > ArmSet::coin_probability(0) + 0.1, "stock share {stock_share}");
        assert!(rush_share > 0.35, "rush share {rush_share}");
        reset();
    }

    #[test]
    fn rarity_rewards_new_contexts_and_the_average_tracks() {
        let _serial = config_override::exclusive_session();
        util_stats::set_enabled(true);
        reset();
        let cell = (2, 2);
        let before = util_stats::snapshot().arm_selector_axis;
        let arms = ArmSet::from_index(COMBINATIONS - 1);
        // The first run sets the average; a repeat of the same context scores
        // below it and a new context scores above it.
        observe(cell, false, &arms, &mut vec![5, 5, 6]);
        observe(cell, false, &arms, &mut vec![5, 6]);
        observe(cell, true, &arms, &mut vec![9]);
        observe(cell, true, &arms, &mut Vec::new());
        let after = util_stats::snapshot().arm_selector_axis;
        util_stats::set_enabled(false);
        assert_eq!(after.observations - before.observations, 4);
        assert_eq!(after.reward_runs_control - before.reward_runs_control, 2);
        assert_eq!(after.reward_positive_control - before.reward_positive_control, 0);
        assert_eq!(after.reward_runs_treated - before.reward_runs_treated, 2);
        assert_eq!(after.reward_positive_treated - before.reward_positive_treated, 1);
        assert_eq!(after.keys_live, 3);
        assert_eq!(after.runs_without_keys - before.runs_without_keys, 1);
        assert_eq!(after.reward_runs_by_arm[3] - before.reward_runs_by_arm[3], 4);
        assert_eq!(after.reward_positive_by_arm[3] - before.reward_positive_by_arm[3], 1);
        assert_eq!(after.cells, 1);
        assert_eq!(
            after.control_runs_by_combination[COMBINATIONS - 1]
                - before.control_runs_by_combination[COMBINATIONS - 1],
            2
        );
        for d in arms.directions() {
            assert_eq!(
                after.control_runs_by_direction[d] - before.control_runs_by_direction[d],
                2
            );
        }
        reset();
        assert_eq!(util_stats::snapshot().arm_selector_axis.cells, 0);
    }

    #[test]
    fn the_key_packs_every_field_without_overlap() {
        let a = delivery_key(3, 0x1234, true, false, 0);
        let b = delivery_key(3, 0x1234, true, false, 2);
        let c = delivery_key(3, 0x1234, false, true, 5);
        let d = delivery_key(4, 0x1234, true, false, 0);
        let e = delivery_key(3, 0x1235, true, false, 0);
        let all = [a, b, c, d, e];
        for i in 0..all.len() {
            for j in i + 1..all.len() {
                assert_ne!(all[i], all[j], "keys {i} and {j} collide");
            }
        }
        assert_eq!(delivery_key(0, 0, false, false, 1), delivery_key(0, 0, false, false, 3));
        assert_eq!(delivery_key(0, 0, false, false, 16), delivery_key(0, 0, false, false, 400));
    }
}
