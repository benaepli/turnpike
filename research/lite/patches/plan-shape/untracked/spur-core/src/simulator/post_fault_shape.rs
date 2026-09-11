//! What kind of client request a plan reserves for after a node restart,
//! and whether a read is ordered behind it.
//!
//! The post-fault pass draws the request it orders behind each restart
//! uniformly over the plan's client requests, so it is a write about one
//! time in three, and every read the pass did not reserve is ready at the
//! run's first step. On the write-then-read cell the pass takes the first
//! write-like request its draw offers instead, and then pulls one of the
//! plan's reads behind that write, so the read becomes ready only once the
//! write's response has completed the plan event. The plan has the same
//! events either way; only the edges differ.
//!
//! A plan always keeps at least one write-like request that no restart
//! reserves: when taking the write would reserve the last one, the pass
//! makes its stock choice instead.
//!
//! The cell is a pure function of the workload seed, as the recover-deps
//! cell is, drawn under its own salt so it is independent of every other
//! cell drawn over the seed. A child run that replays its parent's plan
//! inherits the parent's workload seed and so its cell.

use crate::simulator::run_phase;

/// Domain salt for the cell draw.
pub const SHAPE_SALT: u64 = 0x_5752_4954_4552_4541; // "WRITEREA"

/// The cell a run's plan is generated under.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PostFaultShape {
    /// The request reserved behind a restart is drawn uniformly.
    #[default]
    Stock,
    /// The request reserved behind a restart is a write when one is free,
    /// and one read is ordered behind that write's response.
    WriteThenRead,
}

impl PostFaultShape {
    /// The cell the workload seed names: half the seeds write-then-read,
    /// half stock.
    pub fn of_workload_seed(workload_seed: u64) -> Self {
        match run_phase::salted_phase(workload_seed as i64, SHAPE_SALT, 2) {
            1 => PostFaultShape::WriteThenRead,
            _ => PostFaultShape::Stock,
        }
    }

    /// The index this cell occupies in per-cell tallies.
    pub fn index(self) -> usize {
        match self {
            PostFaultShape::Stock => 0,
            PostFaultShape::WriteThenRead => 1,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::simulator::recover_deps::RecoverDeps;
    use crate::simulator::rng::{WORKLOAD_SALT, derive_seed};

    #[test]
    fn the_cell_is_a_function_of_the_workload_seed_alone() {
        for seed in 0..10_000u64 {
            let a = PostFaultShape::of_workload_seed(seed);
            assert_eq!(a, PostFaultShape::of_workload_seed(seed), "seed {seed} varies");
        }
        assert_eq!(PostFaultShape::Stock.index(), 0);
        assert_eq!(PostFaultShape::WriteThenRead.index(), 1);
    }

    #[test]
    fn each_cell_gets_close_to_half_over_derived_seeds() {
        let n = 40_000i64;
        let mut treated = 0u32;
        for run_id in 0..n {
            let seed = derive_seed(7, run_id, WORKLOAD_SALT);
            treated +=
                (PostFaultShape::of_workload_seed(seed) == PostFaultShape::WriteThenRead) as u32;
        }
        let share = treated as f64 / n as f64;
        assert!((share - 0.5).abs() < 0.02, "write-then-read takes {share}");
    }

    #[test]
    fn the_cell_is_independent_of_the_recover_deps_cell() {
        let n = 40_000i64;
        let mut agree = 0i64;
        for run_id in 0..n {
            let seed = derive_seed(11, run_id, WORKLOAD_SALT);
            let treated = PostFaultShape::of_workload_seed(seed) == PostFaultShape::WriteThenRead;
            let exempt = RecoverDeps::of_workload_seed(seed) == RecoverDeps::Exempt;
            agree += (treated == exempt) as i64;
        }
        let share = agree as f64 / n as f64;
        assert!((share - 0.5).abs() < 0.02, "the write-read cell follows the recover-deps cell on {share}");
    }

    #[test]
    fn the_cell_follows_the_seed_and_not_the_id_that_issued_the_run() {
        let n = 20_000i64;
        let mut agree = 0i64;
        for run_id in 0..n {
            let seed = derive_seed(11, run_id, WORKLOAD_SALT);
            let by_seed = PostFaultShape::of_workload_seed(seed);
            let by_id = match run_phase::salted_phase(run_id, SHAPE_SALT, 2) {
                1 => PostFaultShape::WriteThenRead,
                _ => PostFaultShape::Stock,
            };
            agree += (by_seed == by_id) as i64;
        }
        let share = agree as f64 / n as f64;
        assert!((share - 0.5).abs() < 0.02, "the seed's cell follows the id on {share}");
    }
}
