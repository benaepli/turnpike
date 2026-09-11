//! Whether the client requests a plan reserves for after a node restart
//! are addressed to a server the plan never crashes.
//!
//! The post-fault pass orders one client request behind each restart and
//! leaves that request's target where the workload drew it, uniformly over
//! the servers, so about one reserved target in three is a server the plan
//! itself takes down at some point. On the survivor cell every reserved
//! request whose target crashes somewhere in the plan is readdressed to a
//! server that never does; a plan that crashes every server keeps its
//! targets. Requests the pass did not reserve, and every edge, are left as
//! the stock generator made them.
//!
//! The cell is a pure function of the workload seed, as the recover-deps
//! cell is, and is drawn under its own salt so the two are independent. A
//! child run that replays its parent's plan inherits the parent's workload
//! seed and so its cell. The target draw is made from the workload seed
//! under a further salt, beside the workload stream rather than from it, so
//! the stock cell's plan is byte-identical to the generator's output.

use rand::SeedableRng;
use rand::rngs::SmallRng;

use crate::simulator::rng::splitmix;
use crate::simulator::run_phase;

/// Domain salt for the cell draw.
pub const SURVIVOR_SALT: u64 = 0x_5355_5256_4956_4F52; // "SURVIVOR"

/// Domain salt for the target draw, distinct from the cell salt so the
/// targets a plan takes say nothing about which cell it is in.
pub const TARGET_SALT: u64 = 0x_5355_5256_5441_5247; // "SURVTARG"

/// The cell a run's plan is generated under.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SurvivorTarget {
    /// Reserved requests keep the targets the workload drew.
    #[default]
    Stock,
    /// Reserved requests addressed to a crashing server are readdressed to
    /// a server the plan never crashes.
    Survivor,
}

impl SurvivorTarget {
    /// The cell the workload seed names: half the seeds survivor, half stock.
    pub fn of_workload_seed(workload_seed: u64) -> Self {
        match run_phase::salted_phase(workload_seed as i64, SURVIVOR_SALT, 2) {
            1 => SurvivorTarget::Survivor,
            _ => SurvivorTarget::Stock,
        }
    }

    /// The index this cell occupies in per-cell tallies.
    pub fn index(self) -> usize {
        match self {
            SurvivorTarget::Stock => 0,
            SurvivorTarget::Survivor => 1,
        }
    }

    /// The generator that draws replacement targets for the plan of
    /// `workload_seed`. Seeded beside the workload stream, never from it.
    pub fn target_rng(workload_seed: u64) -> SmallRng {
        SmallRng::seed_from_u64(splitmix(workload_seed ^ TARGET_SALT))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::simulator::post_fault_shape::PostFaultShape;
    use crate::simulator::recover_deps::RecoverDeps;
    use crate::simulator::rng::{WORKLOAD_SALT, derive_seed};
    use rand::Rng;

    #[test]
    fn the_cell_is_a_function_of_the_workload_seed_alone() {
        for seed in 0..10_000u64 {
            let a = SurvivorTarget::of_workload_seed(seed);
            assert_eq!(a, SurvivorTarget::of_workload_seed(seed), "seed {seed} varies");
        }
        assert_eq!(SurvivorTarget::Stock.index(), 0);
        assert_eq!(SurvivorTarget::Survivor.index(), 1);
    }

    #[test]
    fn each_cell_gets_close_to_half_over_derived_seeds() {
        let n = 40_000i64;
        let mut survivor = 0u32;
        for run_id in 0..n {
            let seed = derive_seed(7, run_id, WORKLOAD_SALT);
            survivor += (SurvivorTarget::of_workload_seed(seed) == SurvivorTarget::Survivor) as u32;
        }
        let share = survivor as f64 / n as f64;
        assert!((share - 0.5).abs() < 0.02, "survivor takes {share}");
    }

    #[test]
    fn the_cell_is_independent_of_the_other_plan_cells() {
        let n = 40_000i64;
        let mut agree_deps = 0i64;
        let mut agree_shape = 0i64;
        for run_id in 0..n {
            let seed = derive_seed(11, run_id, WORKLOAD_SALT);
            let survivor = SurvivorTarget::of_workload_seed(seed) == SurvivorTarget::Survivor;
            let exempt = RecoverDeps::of_workload_seed(seed) == RecoverDeps::Exempt;
            let write_read =
                PostFaultShape::of_workload_seed(seed) == PostFaultShape::WriteThenRead;
            agree_deps += (survivor == exempt) as i64;
            agree_shape += (survivor == write_read) as i64;
        }
        let deps = agree_deps as f64 / n as f64;
        let shape = agree_shape as f64 / n as f64;
        assert!((deps - 0.5).abs() < 0.02, "the survivor cell follows the recover-deps cell on {deps}");
        assert!((shape - 0.5).abs() < 0.02, "the survivor cell follows the write-read cell on {shape}");
    }

    #[test]
    fn the_cell_follows_the_seed_and_not_the_id_that_issued_the_run() {
        let n = 20_000i64;
        let mut agree = 0i64;
        for run_id in 0..n {
            let seed = derive_seed(11, run_id, WORKLOAD_SALT);
            let by_seed = SurvivorTarget::of_workload_seed(seed);
            let by_id = match run_phase::salted_phase(run_id, SURVIVOR_SALT, 2) {
                1 => SurvivorTarget::Survivor,
                _ => SurvivorTarget::Stock,
            };
            agree += (by_seed == by_id) as i64;
        }
        let share = agree as f64 / n as f64;
        assert!((share - 0.5).abs() < 0.02, "the seed's cell follows the id on {share}");
    }

    #[test]
    fn the_target_draw_is_a_function_of_the_seed_and_differs_between_seeds() {
        fn draws(mut rng: SmallRng) -> Vec<u32> {
            (0..8).map(|_| rng.random()).collect()
        }
        let a = draws(SurvivorTarget::target_rng(5));
        assert_eq!(a, draws(SurvivorTarget::target_rng(5)));
        assert_ne!(a, draws(SurvivorTarget::target_rng(6)));
        assert_ne!(a, draws(SmallRng::seed_from_u64(5)), "the target draw is the workload stream");
    }
}
