//! The request wait and the shelter have to fire on a real workload, each
//! on its own half of the runs, and change nothing on the other half.
//!
//! Over a session of runs on a fixture whose restart asks every peer and
//! whose peers answer, and whose writes fan out to every peer, a run on the
//! wait's treated half must mask a request-caused record at an unsettled
//! restarted destination, and a run on the shelter's treated half must move
//! a fault-touched record at a post-fault invocation. Every run is tagged
//! with the bits its id draws, and no probe carries either. On the runs
//! outside both halves neither mechanism fires and the same run id gives
//! the same event sequence twice.

use spur_core::compiler;
use spur_core::simulator::config_override;
use spur_core::simulator::explorer::{
    ExplorerConfig, GlobalState, NoFeedback, RunAttribution, SingleRunConfig, run_single_simulation,
};
use spur_core::simulator::history::{HistoryWriter, LogBackend, create_writer};
use spur_core::simulator::rng::LiveRng;
use spur_core::simulator::util_stats::{RequestWaitStats, ShelterStats, UtilizationSnapshot};
use spur_core::simulator::{
    fault_timing, op_shelter, request_wait, run_cap, run_variant, timer_context, util_stats,
};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const SPEC: &str = include_str!("fixtures/opening.spur");

const CONFIG: &str = r#"{
  "num_servers": {"min": 3, "max": 3, "step": 1},
  "num_write_ops": {"min": 6, "max": 6, "step": 1},
  "num_read_ops": {"min": 2, "max": 2, "step": 1},
  "num_keys": {"min": 1, "max": 1, "step": 1},
  "num_crashes": {"min": 2, "max": 2, "step": 1},
  "dependency_density": [0.3],
  "post_fault_client_ops": 2,
  "num_runs_per_config": 1,
  "max_iterations": 600,
  "session_seed": 4243,
  "queue_policy": {"type": "Probabilistic", "p_local": 0.7, "p_timer": 0.2},
  "rng_stream_isolation": true,
  "strict_config_keys": true,
  "stats": true
}"#;

const BACKUP: i32 = 600;
const SEEDED_LENGTH: i32 = 30;
const HALF_RUNS: usize = 80;
const UNTREATED_RUNS: usize = 12;
const SESSION_STACK_BYTES: usize = 64 * 1024 * 1024;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("spur_treatment_halves_{name}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("creates scratch directory");
    dir
}

fn columns(dir: &Path, table: &str, names: &[&str]) -> Vec<Vec<String>> {
    use arrow::array::AsArray;
    use arrow::datatypes::{DataType, Int32Type, Int64Type};
    use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
    let mut rows = Vec::new();
    for entry in fs::read_dir(dir.join(table)).expect("table dir") {
        let path = entry.expect("entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("parquet") {
            continue;
        }
        let reader = ParquetRecordBatchReaderBuilder::try_new(fs::File::open(&path).unwrap())
            .unwrap()
            .build()
            .unwrap();
        for batch in reader {
            let batch = batch.unwrap();
            for i in 0..batch.num_rows() {
                let mut row = Vec::new();
                for name in names {
                    let col = batch
                        .column_by_name(name)
                        .unwrap_or_else(|| panic!("column {name} of {table}"));
                    row.push(match col.data_type() {
                        DataType::Int32 => col.as_primitive::<Int32Type>().value(i).to_string(),
                        DataType::Int64 => col.as_primitive::<Int64Type>().value(i).to_string(),
                        DataType::Utf8 => col.as_string::<i32>().value(i).to_string(),
                        other => panic!("column {name} is {other:?}"),
                    });
                }
                rows.push(row);
            }
        }
    }
    rows
}

fn compile() -> (spur_core::compiler::cfg::Program, SingleRunConfig) {
    let program = compiler::compile(SPEC, "opening.spur")
        .into_program()
        .expect("spec compiles");
    let config: ExplorerConfig = serde_json::from_str(CONFIG).expect("config parses");
    let run_config = config
        .expand_grid()
        .into_iter()
        .next()
        .expect("the grid holds one config");
    (program, run_config)
}

/// Runs `ids` into `out`, one at a time, and returns for each run the
/// change in the two firing counters it produced.
fn session(
    program: &spur_core::compiler::cfg::Program,
    run_config: &SingleRunConfig,
    ids: &[i64],
    out: &Path,
) -> BTreeMap<i64, (u64, u64)> {
    let writer: Arc<dyn HistoryWriter> = Arc::from(
        create_writer(LogBackend::Parquet, out.to_str().expect("utf-8 path"))
            .expect("creates writer"),
    );
    let global_state = GlobalState::<NoFeedback>::new();
    let mut fired = BTreeMap::new();
    for &run_id in ids {
        let before = util_stats::snapshot();
        spur_core::simulator::arm_selector::reset();
        run_single_simulation::<NoFeedback, LiveRng>(
            program,
            &writer,
            &global_state,
            run_id,
            run_config,
            &Default::default(),
            0x_C0FF_EE00 ^ run_id as u64,
            0x_5EED_1234 ^ run_id as u64,
            None,
            &RunAttribution::mode("test"),
        )
        .expect("the run executes");
        let after = util_stats::snapshot();
        fired.insert(
            run_id,
            (
                after.request_wait.records_masked - before.request_wait.records_masked,
                after.shelter.ops_sheltered - before.shelter.ops_sheltered,
            ),
        );
    }
    writer.shutdown();
    fired
}

fn runs(dir: &Path) -> HashMap<i64, (String, i32)> {
    columns(dir, "runs", &["run_id", "end_reason", "variant"])
        .into_iter()
        .map(|r| (r[0].parse().unwrap(), (r[1].clone(), r[2].parse().unwrap())))
        .collect()
}

/// Feeds the span learner so placed runs draw a crash hold inside a run.
fn seed_span() {
    let feeder = (0..1_000_000i64)
        .find(|&id| run_cap::is_probe(id))
        .expect("some run id is a probe");
    for _ in 0..200 {
        fault_timing::merge_stock_probe(feeder, BACKUP, run_cap::Outcome::Completed, SEEDED_LENGTH);
    }
}

fn is_probe(id: i64) -> bool {
    run_cap::is_probe(id) || timer_context::run_mode(id) == timer_context::RunMode::Probe
}

fn ids(wait: bool, shelter: bool, n: usize) -> Vec<i64> {
    let ids: Vec<i64> = (0..1_000_000i64)
        .filter(|&id| {
            !is_probe(id)
                && request_wait::is_treated(id) == wait
                && op_shelter::is_treated(id) == shelter
                && fault_timing::is_placed(id)
        })
        .take(n)
        .collect();
    assert_eq!(ids.len(), n, "not enough run ids in the cell");
    ids
}

fn wait_delta(a: &UtilizationSnapshot, b: &UtilizationSnapshot) -> (u64, u64, u64, u64, u64, u64) {
    let (a, b): (&RequestWaitStats, &RequestWaitStats) = (&a.request_wait, &b.request_wait);
    (
        a.masked_offers - b.masked_offers,
        a.records_masked - b.records_masked,
        a.released_settled - b.released_settled,
        a.released_bound - b.released_bound,
        a.released_lifted - b.released_lifted,
        a.settle.treated.settled + a.settle.untreated.settled
            - b.settle.treated.settled
            - b.settle.untreated.settled,
    )
}

fn shelter_delta(a: &UtilizationSnapshot, b: &UtilizationSnapshot) -> (u64, u64, u64, u64, u64) {
    let (a, b): (&ShelterStats, &ShelterStats) = (&a.shelter, &b.shelter);
    (
        a.ops_examined - b.ops_examined,
        a.ops_sheltered - b.ops_sheltered,
        a.released_on_response - b.released_on_response,
        a.released_on_expiry - b.released_on_expiry,
        a.released_dry - b.released_dry,
    )
}

#[test]
fn each_treated_half_fires_and_is_tagged() {
    std::thread::Builder::new()
        .stack_size(SESSION_STACK_BYTES)
        .spawn(check_treated)
        .expect("spawns the session thread")
        .join()
        .expect("the session thread runs to completion");
}

fn check_treated() {
    let _serial = config_override::exclusive_session();
    run_cap::reset();
    fault_timing::reset();
    seed_span();
    let (program, run_config) = compile();

    // The wait's half, with the shelter off so the mask is read alone.
    let wait_ids = ids(true, false, HALF_RUNS);
    let out = scratch("wait");
    util_stats::set_enabled(true);
    let before = util_stats::snapshot();
    let fired = session(&program, &run_config, &wait_ids, &out);
    let after_wait = util_stats::snapshot();
    let (offers, masked, settled, bound, lifted, settles) = wait_delta(&after_wait, &before);
    eprintln!(
        "request_wait: offers {offers} masked {masked} settled {settled} bound {bound} lifted {lifted} settles {settles}"
    );
    eprintln!("request_wait block: {:?}", after_wait.request_wait);
    let mut ends: BTreeMap<String, usize> = BTreeMap::new();
    for (end, _) in runs(&out).values() {
        *ends.entry(end.clone()).or_default() += 1;
    }
    eprintln!("ends: {ends:?}");
    assert!(masked > 0, "no request-caused record was ever masked");
    assert!(offers >= masked, "a record was masked on fewer steps than it was counted");
    assert!(settles > 0, "no restart ever settled");
    assert_eq!(after_wait.shelter.ops_examined, before.shelter.ops_examined, "the shelter ran on its untreated half");
    let runs_table = runs(&out);
    assert_eq!(runs_table.len(), HALF_RUNS);
    for id in &wait_ids {
        let (_, variant) = &runs_table[id];
        assert_ne!(variant & run_variant::REQUEST_WAITS_FOR_SETTLE, 0, "run {id} is not tagged");
        assert_eq!(variant & run_variant::OP_TARGET_SHELTER, 0, "run {id} carries the shelter bit");
    }
    assert!(fired.values().any(|(m, _)| *m > 0), "the counter moved but no run owns it");
    assert!(fired.values().all(|(_, s)| *s == 0));

    // The shelter's half, with the wait off.
    run_cap::reset();
    fault_timing::reset();
    seed_span();
    let shelter_ids = ids(false, true, HALF_RUNS);
    let shelter_out = scratch("shelter");
    let fired = session(&program, &run_config, &shelter_ids, &shelter_out);
    let after_shelter = util_stats::snapshot();
    util_stats::set_enabled(false);
    run_cap::reset();
    fault_timing::reset();
    let (examined, sheltered, on_response, on_expiry, dry) =
        shelter_delta(&after_shelter, &after_wait);
    eprintln!(
        "shelter: examined {examined} sheltered {sheltered} response {on_response} expiry {on_expiry} dry {dry}"
    );
    assert!(examined > 0, "no post-fault invocation was examined");
    assert!(sheltered > 0, "no invocation ever sheltered a record");
    assert!(on_response + on_expiry + dry > 0, "a sheltered record was never released");
    assert_eq!(
        after_shelter.request_wait.records_masked, after_wait.request_wait.records_masked,
        "the wait masked on its untreated half"
    );
    let runs_table = runs(&shelter_out);
    for id in &shelter_ids {
        let (_, variant) = &runs_table[id];
        assert_ne!(variant & run_variant::OP_TARGET_SHELTER, 0, "run {id} is not tagged");
        assert_eq!(variant & run_variant::REQUEST_WAITS_FOR_SETTLE, 0, "run {id} carries the wait bit");
    }
    assert!(fired.values().any(|(_, s)| *s > 0), "the counter moved but no run owns it");
    assert!(fired.values().all(|(m, _)| *m == 0));
    let _ = fs::remove_dir_all(&out);
    let _ = fs::remove_dir_all(&shelter_out);
}

#[test]
fn untreated_runs_are_unchanged_and_never_fire() {
    std::thread::Builder::new()
        .stack_size(SESSION_STACK_BYTES)
        .spawn(check_untreated)
        .expect("spawns the session thread")
        .join()
        .expect("the session thread runs to completion");
}

fn check_untreated() {
    let _serial = config_override::exclusive_session();
    run_cap::reset();
    fault_timing::reset();
    let (program, run_config) = compile();
    let untreated = ids(false, false, UNTREATED_RUNS);

    util_stats::set_enabled(true);
    let before = util_stats::snapshot();
    seed_span();
    let first = scratch("untreated_first");
    let fired_first = session(&program, &run_config, &untreated, &first);
    run_cap::reset();
    fault_timing::reset();
    seed_span();
    let second = scratch("untreated_second");
    let fired_second = session(&program, &run_config, &untreated, &second);
    let after = util_stats::snapshot();
    util_stats::set_enabled(false);
    run_cap::reset();
    fault_timing::reset();

    for by_run in [&fired_first, &fired_second] {
        assert!(by_run.values().all(|f| *f == (0, 0)), "an untreated run fired");
    }
    let (offers, masked, settled, bound, lifted, settles) = wait_delta(&after, &before);
    assert_eq!((offers, masked, settled, bound, lifted), (0, 0, 0, 0, 0));
    assert!(settles > 0, "the settle census is read on both halves");
    assert_eq!(after.request_wait.lift_steps, before.request_wait.lift_steps);
    assert_eq!(after.request_wait.arrivals_after_bound, before.request_wait.arrivals_after_bound);
    assert_eq!(after.request_wait.settle.treated.settled, before.request_wait.settle.treated.settled);
    assert_eq!(shelter_delta(&after, &before), (0, 0, 0, 0, 0));
    assert_eq!(
        after.shelter.stall_clock_steps_not_suspended,
        before.shelter.stall_clock_steps_not_suspended
    );
    assert!(
        after.request_wait.cells.untreated.request_entries_at_restarted
            > before.request_wait.cells.untreated.request_entries_at_restarted,
        "the entry census is read on the untreated half"
    );
    assert_eq!(
        after.request_wait.cells.treated.request_entries_at_restarted,
        before.request_wait.cells.treated.request_entries_at_restarted
    );
    assert_eq!(
        after.shelter.cells.treated.sender_restarted_entries,
        before.shelter.cells.treated.sender_restarted_entries
    );

    for id in &untreated {
        let (_, variant) = runs(&first)[id];
        assert_eq!(
            variant & (run_variant::REQUEST_WAITS_FOR_SETTLE | run_variant::OP_TARGET_SHELTER),
            0,
            "run {id} is tagged treated"
        );
    }

    let rows = |dir: &Path| -> BTreeSet<Vec<String>> {
        columns(
            dir,
            "executions",
            &["run_id", "seq_num", "kind", "action", "payload", "step"],
        )
        .into_iter()
        .collect()
    };
    let (r1, r2) = (rows(&first), rows(&second));
    assert!(!r1.is_empty(), "the first session wrote nothing");
    assert_eq!(r1, r2, "the same untreated run ids gave different event sequences");
    let _ = fs::remove_dir_all(&first);
    let _ = fs::remove_dir_all(&second);
}

#[test]
fn no_probe_carries_either_bit_and_the_cells_cross() {
    let mut cells = [0usize; 4];
    let mut unprobed = 0usize;
    for id in 0..64_000i64 {
        let v = run_variant::from_run_id(id);
        let wait = v & run_variant::REQUEST_WAITS_FOR_SETTLE != 0;
        let shelter = v & run_variant::OP_TARGET_SHELTER != 0;
        if is_probe(id) {
            assert!(!wait && !shelter, "probe {id} is treated");
            continue;
        }
        unprobed += 1;
        cells[(wait as usize) << 1 | shelter as usize] += 1;
    }
    for (i, &n) in cells.iter().enumerate() {
        let share = n as f64 / unprobed as f64;
        assert!((share - 0.25).abs() < 0.02, "cell {i} takes {share}");
    }
}
