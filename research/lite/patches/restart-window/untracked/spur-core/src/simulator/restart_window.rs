//! The restart window: a stretch of steps after a node comes back from a
//! crash during which the queue-group policy switches shape, and the cell a
//! run occupies in that mechanism's split.
//!
//! A window opens on the step a recover is applied and closes once the
//! restarted node has taken `ENTRY_LIMIT` handler entries since its restart
//! or `STEP_LIMIT` steps have passed, whichever comes first. Windows of
//! several nodes union: the switch is on while any window is open. What the
//! switch does depends on the run's cell; the stock cells track windows for
//! the census only and never change a selection.

use crate::simulator::run_cap;
use crate::simulator::run_phase;
use crate::simulator::timer_context;

pub const WINDOW_SALT: u64 = 0x_5253_5457_494E_444F; // "RSTWINDO"

/// Handler entries since restart at which a node's window closes.
pub const ENTRY_LIMIT: u32 = 8;
/// Steps after the opening step at which a window closes if the entry limit
/// was not reached.
pub const STEP_LIMIT: i32 = 96;
/// Local steps between forced network pulls inside a window on the
/// local-drain cell.
pub const NET_PULL_INTERVAL: i32 = 16;
/// The local share of the roll inside a window on the network-heavy cell.
pub const NET_HEAVY_P_LOCAL: f64 = 0.5;

/// Number of cells the census splits by.
pub const CELLS: usize = 3;

/// The shape a run's queue-group policy takes inside an open window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cell {
    /// The configured selector, unchanged inside and outside a window.
    Stock,
    /// The active node's local queue is drained before any other group,
    /// with one network pull forced every `NET_PULL_INTERVAL` local steps.
    LocalDrain,
    /// The stock roll shape with the local share lowered to
    /// `NET_HEAVY_P_LOCAL`, so deliveries come denser.
    NetHeavy,
}

impl Cell {
    /// The index this cell occupies in the census arrays.
    pub fn index(self) -> usize {
        match self {
            Cell::Stock => 0,
            Cell::LocalDrain => 1,
            Cell::NetHeavy => 2,
        }
    }
}

/// The cell of a run. Probes of the run-cap and timer-context mechanisms
/// stay on the stock cell; the other runs split in quarters, two of which
/// are stock so each treated cell is contrasted against an equal stock
/// share.
pub fn cell(run_id: i64) -> Cell {
    if run_cap::is_probe(run_id) || timer_context::run_mode(run_id) == timer_context::RunMode::Probe
    {
        return Cell::Stock;
    }
    match run_phase::salted_phase(run_id, WINDOW_SALT, 4) {
        2 => Cell::LocalDrain,
        3 => Cell::NetHeavy,
        _ => Cell::Stock,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::simulator::config_override;

    #[test]
    fn probes_stay_on_the_stock_cell() {
        let _serial = config_override::exclusive_session();
        for id in -20_000..20_000i64 {
            let probe = run_cap::is_probe(id)
                || timer_context::run_mode(id) == timer_context::RunMode::Probe;
            if probe {
                assert_eq!(cell(id), Cell::Stock, "run {id}: a probe took a treated cell");
            }
            assert_eq!(cell(id), cell(id), "run {id}: the cell must not vary between reads");
        }
    }

    #[test]
    fn each_treated_cell_takes_a_quarter_of_the_unexempt_runs() {
        let _serial = config_override::exclusive_session();
        let mut counts = [0usize; CELLS];
        let mut unexempt = 0usize;
        for id in 0..40_000i64 {
            if run_cap::is_probe(id)
                || timer_context::run_mode(id) == timer_context::RunMode::Probe
            {
                continue;
            }
            unexempt += 1;
            counts[cell(id).index()] += 1;
        }
        for (name, i, want) in [("stock", 0, 0.5), ("local drain", 1, 0.25), ("net heavy", 2, 0.25)]
        {
            let share = counts[i] as f64 / unexempt as f64;
            assert!((share - want).abs() < 0.02, "the {name} cell holds {share} of the runs");
        }
    }

    #[test]
    fn the_split_is_independent_of_the_other_salted_mechanisms() {
        let _serial = config_override::exclusive_session();
        let n = 40_000i64;
        let mut treated = 0i64;
        let mut treated_and_fresh_first = 0i64;
        for id in 0..n {
            if cell(id) == Cell::LocalDrain {
                treated += 1;
                if crate::simulator::fresh_first::is_treated(id) {
                    treated_and_fresh_first += 1;
                }
            }
        }
        let overlap = treated_and_fresh_first as f64 / treated as f64;
        assert!((overlap - 0.5).abs() < 0.03, "the local-drain cell follows fresh-first on {overlap}");
    }
}
