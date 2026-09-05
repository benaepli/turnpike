//! A state-fork child continues its parent's run from the snapshot taken at
//! the fault-crossing signal. Drawing from a copy of the parent's generators
//! at the snapshot, it has to reproduce the parent's whole event sequence
//! and ending; drawing from its own generators, it has to agree with the
//! parent up to the signal step. Its row carries the steps of prefix and
//! continuation together and the parent's mechanism bits, whatever its own
//! id would have selected.

use spur_core::compiler;
use spur_core::simulator::config_override;
use spur_core::simulator::explorer::{
    ExplorerConfig, ForkPoint, GlobalState, NoFeedback, NoHashing, RunAttribution, RunResult,
    SingleRunConfig, continuation_variant_bits, run_continuation, run_single_simulation,
};
use spur_core::simulator::history::{HistoryWriter, LogBackend, create_writer};
use spur_core::simulator::rng::{RecordRng, StreamSet};
use spur_core::simulator::{fault_timing, run_cap, run_variant, util_stats};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const SPEC: &str = include_str!("fixtures/ghost.spur");

const CONFIG: &str = r#"{
  "num_servers": {"min": 3, "max": 3, "step": 1},
  "num_write_ops": {"min": 4, "max": 4, "step": 1},
  "num_read_ops": {"min": 2, "max": 2, "step": 1},
  "num_keys": {"min": 1, "max": 1, "step": 1},
  "num_crashes": {"min": 2, "max": 2, "step": 1},
  "dependency_density": [0.0],
  "num_runs_per_config": 1,
  "max_iterations": 600,
  "session_seed": 4242,
  "queue_policy": {"type": "Probabilistic", "p_local": 0.7, "p_timer": 0.2},
  "rng_stream_isolation": true,
  "strict_config_keys": true,
  "stats": true
}"#;

const SESSION_STACK_BYTES: usize = 64 * 1024 * 1024;
const PARENT_CANDIDATES: usize = 200;
const BACKUP: i32 = 600;
/// Completed-length samples the span learner is fed, well short of a run, so
/// a placed crash waits inside a run and a delivery can reach its node first.
const SEEDED_LENGTH: i32 = 30;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("spur_state_fork_{name}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("creates scratch directory");
    dir
}

fn columns(dir: &Path, table: &str, names: &[&str]) -> Vec<Vec<String>> {
    use arrow::array::{Array, AsArray};
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
    let program = compiler::compile(SPEC, "ghost.spur")
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

fn writer(dir: &Path) -> Arc<dyn HistoryWriter> {
    Arc::from(
        create_writer(LogBackend::Parquet, dir.to_str().expect("utf-8 path"))
            .expect("creates writer"),
    )
}

fn seed_span() {
    let feeder = (0..1_000_000i64)
        .find(|&id| run_cap::is_probe(id))
        .expect("some run id is a probe");
    for _ in 0..200 {
        fault_timing::merge_stock_probe(feeder, BACKUP, run_cap::Outcome::Completed, SEEDED_LENGTH);
    }
    assert!(
        fault_timing::median(BACKUP).is_some_and(|m| m < 64),
        "the seeded span must be short enough to expire inside a run"
    );
}

fn workload_seed(run_id: i64) -> u64 {
    0x_C0FF_EE00 ^ run_id as u64
}

fn schedule_seed(run_id: i64) -> u64 {
    0x_5EED_1234 ^ run_id as u64
}

fn run_parent(
    program: &spur_core::compiler::cfg::Program,
    run_config: &SingleRunConfig,
    writer: &Arc<dyn HistoryWriter>,
    run_id: i64,
) -> RunResult {
    run_single_simulation::<NoFeedback, RecordRng>(
        program,
        writer,
        &GlobalState::<NoFeedback>::new(),
        run_id,
        run_config,
        &Default::default(),
        workload_seed(run_id),
        schedule_seed(run_id),
        None,
        true,
        &RunAttribution::mode("test"),
    )
    .expect("the run executes")
}

fn run_child(
    program: &spur_core::compiler::cfg::Program,
    run_config: &SingleRunConfig,
    writer: &Arc<dyn HistoryWriter>,
    run_id: i64,
    fork: &ForkPoint<NoHashing, NoFeedback>,
    streams: StreamSet,
    schedule: u64,
) -> RunResult {
    run_continuation::<NoFeedback>(
        program,
        writer,
        &GlobalState::<NoFeedback>::new(),
        run_id,
        fork,
        run_config,
        &Default::default(),
        workload_seed(fork.parent_run_id),
        schedule,
        streams,
        &RunAttribution::mode("test"),
    )
    .expect("the continuation executes")
}

/// Events by sequence number, without the run id: what a run did and when.
fn events_through(dir: &Path, last_step: i32) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = columns(
        dir,
        "executions",
        &["seq_num", "kind", "action", "payload", "step"],
    )
    .into_iter()
    .filter(|r| r[4].parse::<i32>().expect("step") <= last_step)
    .collect();
    rows.sort_by_key(|r| r[0].parse::<i64>().expect("seq_num"));
    rows
}

/// The one run row of a directory: steps_used, end_reason, wall_us, variant.
fn run_row(dir: &Path) -> BTreeMap<String, String> {
    let rows = columns(
        dir,
        "runs",
        &["run_id", "steps_used", "end_reason", "wall_us", "variant"],
    );
    assert_eq!(rows.len(), 1, "one run row per directory");
    let r = &rows[0];
    [
        ("run_id", &r[0]),
        ("steps_used", &r[1]),
        ("end_reason", &r[2]),
        ("wall_us", &r[3]),
        ("variant", &r[4]),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.clone()))
    .collect()
}

#[test]
fn a_fork_child_walks_in_its_parents_steps() {
    std::thread::Builder::new()
        .stack_size(SESSION_STACK_BYTES)
        .spawn(check_fork)
        .expect("spawns the session thread")
        .join()
        .expect("the session thread runs to completion");
}

fn check_fork() {
    let _serial = config_override::exclusive_session();
    run_cap::reset();
    fault_timing::reset();
    seed_span();
    util_stats::set_enabled(true);
    let (program, run_config) = compile();
    // Placed runs hold a queued crash back, which is what lets a delivery
    // reach its node first; probes are left out so the parent's mechanism
    // bits are exactly what a child carries.
    let eligible = |id: i64| {
        let v = run_variant::from_run_id(id);
        v & run_variant::CRASH_PLACED != 0
            && v & (run_variant::RUN_CAP_PROBE | run_variant::TIMER_STEER_OFF) == 0
    };
    let parents: Vec<i64> = (0..1_000_000i64)
        .filter(|&id| eligible(id))
        .take(PARENT_CANDIDATES)
        .collect();
    assert_eq!(parents.len(), PARENT_CANDIDATES, "not enough placed run ids");

    let mut checked = 0;
    for (i, &parent_id) in parents.iter().enumerate() {
        let parent_dir = scratch(&format!("parent_{i}"));
        let w = writer(&parent_dir);
        let stats_before = util_stats::snapshot().replay;
        let parent = run_parent(&program, &run_config, &w, parent_id);
        w.shutdown();
        let Some(cut) = parent.cut else {
            assert!(parent.fork.is_none(), "a run without the signal took a snapshot");
            let _ = fs::remove_dir_all(&parent_dir);
            continue;
        };
        let fork = parent
            .fork
            .as_deref()
            .expect("a parent that fired the signal took a snapshot")
            .downcast_ref::<ForkPoint<NoHashing, NoFeedback>>()
            .expect("the snapshot is the arm's fork point");
        assert_eq!(fork.parent_run_id, parent_id);
        assert_eq!(
            fork.locals.steps(),
            cut.step + 1,
            "the snapshot stands on the step after the signal"
        );
        assert!(fork.snapshot_bytes > 0, "the snapshot has no size");
        let stats_after = util_stats::snapshot().replay;
        assert_eq!(
            stats_after.fork_points_taken,
            stats_before.fork_points_taken + 1,
            "the fork point is counted once"
        );
        assert!(
            stats_after.state_fork_snapshot_bytes_sum
                >= stats_before.state_fork_snapshot_bytes_sum + fork.snapshot_bytes as u64
        );
        let parent_row = run_row(&parent_dir);
        let parent_events = events_through(&parent_dir, i32::MAX);
        assert!(!parent_events.is_empty(), "the parent wrote no events");

        // A child id whose own bits differ from the parent's, so the row's
        // tag can only come from the parent.
        let child_id = (0..1_000_000i64)
            .find(|&id| {
                run_variant::from_run_id(id) != run_variant::from_run_id(parent_id)
                    && run_variant::from_run_id(id)
                        & (run_variant::RUN_CAP_PROBE | run_variant::TIMER_STEER_OFF)
                        == 0
            })
            .expect("a child id with other mechanism bits");

        // Drawing from a copy of the parent's generators at the snapshot,
        // the child reproduces the parent whole.
        let same_dir = scratch(&format!("same_{i}"));
        let w = writer(&same_dir);
        let before = util_stats::snapshot().replay;
        let same = run_child(
            &program,
            &run_config,
            &w,
            child_id,
            fork,
            fork.streams.clone().expect("a recording parent exposes its generators"),
            schedule_seed(parent_id),
        );
        w.shutdown();
        assert_eq!(same.outcome, parent.outcome, "parent {parent_id}: the ending differs");
        assert_eq!(same.cut, parent.cut, "parent {parent_id}: the cut differs");
        assert!(same.fork.is_none(), "a child took a snapshot");
        let same_events = events_through(&same_dir, i32::MAX);
        assert_eq!(
            parent_events, same_events,
            "parent {parent_id}: the child's events differ from the parent's"
        );
        let same_row = run_row(&same_dir);
        assert_eq!(same_row["run_id"], child_id.to_string());
        assert_eq!(
            same_row["steps_used"], parent_row["steps_used"],
            "parent {parent_id}: the child's row does not carry the whole run's steps"
        );
        assert_eq!(same_row["end_reason"], parent_row["end_reason"]);
        assert!(
            same_row["wall_us"].parse::<i64>().expect("wall") > 0,
            "the child's row carries no wall"
        );
        assert_eq!(
            same_row["variant"],
            parent_row["variant"],
            "parent {parent_id}: the child's tag is not the parent's"
        );
        assert_eq!(
            same_row["variant"].parse::<i32>().expect("variant")
                & !run_variant::CRASH_HOLD_DRAWN,
            continuation_variant_bits(parent_id)
        );
        assert_ne!(
            run_variant::from_run_id(child_id),
            same_row["variant"].parse::<i32>().expect("variant") & !run_variant::CRASH_HOLD_DRAWN,
            "the child's own id would have given the same tag, so the check is empty"
        );
        let after = util_stats::snapshot().replay;
        assert_eq!(after.state_fork_children, before.state_fork_children + 1);
        let prefix = after.state_fork_prefix_steps_sum - before.state_fork_prefix_steps_sum;
        let continuation =
            after.state_fork_continuation_steps_sum - before.state_fork_continuation_steps_sum;
        assert_eq!(prefix, fork.locals.steps() as u64);
        assert_eq!(
            prefix + continuation,
            same_row["steps_used"].parse::<u64>().expect("steps"),
            "the step sums do not add up to the row's steps"
        );

        // Drawing from its own generators, the child agrees with the parent
        // through the signal step and is free after it.
        let own_dir = scratch(&format!("own_{i}"));
        let w = writer(&own_dir);
        let own = run_child(
            &program,
            &run_config,
            &w,
            child_id,
            fork,
            StreamSet::new(schedule_seed(child_id), run_config.rng_stream_isolation),
            schedule_seed(child_id),
        );
        w.shutdown();
        assert_eq!(own.cut, parent.cut, "parent {parent_id}: a child lost its parent's cut");
        assert_eq!(
            events_through(&own_dir, cut.step),
            events_through(&parent_dir, cut.step),
            "parent {parent_id}: the child's events up to step {} differ",
            cut.step
        );

        let _ = fs::remove_dir_all(&parent_dir);
        let _ = fs::remove_dir_all(&same_dir);
        let _ = fs::remove_dir_all(&own_dir);
        checked += 1;
        if checked == 3 {
            break;
        }
    }
    util_stats::set_enabled(false);
    run_cap::reset();
    fault_timing::reset();
    assert!(checked > 0, "no candidate parent fired the signal");
}
