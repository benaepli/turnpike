//! A write-ring child has to walk in its parent's steps to the write signal
//! and take the parent's draws keyed on the run id. A fresh run recorded on
//! a fixture whose handlers send to every peer fires the write signal when
//! a client operation reaches a server that never restarted while records
//! from two dead incarnations are still addressed to it; a child that
//! replays the parent's draws up to that point under the parent's id must
//! fire the signal at the same step, carry the parent's mechanism bits, and
//! on the uniform half switch its within-queue selector there and nowhere
//! else, without taking a draw for the switch. A campaign session has to
//! admit write parents, serve write slots from them, and write every
//! counter of the ring to the utilization file.

use serde_json::Value;
use spur_core::compiler;
use spur_core::simulator::campaign::run_explorer_campaign;
use spur_core::simulator::config_override;
use spur_core::simulator::explorer::{
    ExplorerConfig, GlobalState, NoFeedback, RunAttribution, RunResult, SingleRunConfig,
    run_single_simulation,
};
use spur_core::simulator::history::{HistoryWriter, LogBackend, create_writer};
use spur_core::simulator::replay_corpus::WriteChild;
use spur_core::simulator::rng::{RecordRng, Recording, ReplayRng, RngSource};
use spur_core::simulator::{fault_timing, run_cap, run_variant, util_stats};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

const SPEC: &str = include_str!("fixtures/ghost.spur");

const CONFIG: &str = r#"{
  "num_servers": {"min": 3, "max": 3, "step": 1},
  "num_write_ops": {"min": 6, "max": 6, "step": 1},
  "num_read_ops": {"min": 2, "max": 2, "step": 1},
  "num_keys": {"min": 1, "max": 1, "step": 1},
  "num_crashes": {"min": 2, "max": 2, "step": 1},
  "dependency_density": [0.0],
  "post_fault_client_ops": 2,
  "num_runs_per_config": 1,
  "max_iterations": 600,
  "session_seed": 4343,
  "queue_policy": {"type": "Probabilistic", "p_local": 0.7, "p_timer": 0.2},
  "rng_stream_isolation": true,
  "strict_config_keys": true,
  "stats": true
}"#;

const CAMPAIGN_CONFIG: &str = r#"{
  "num_servers": {"min": 3, "max": 3, "step": 1},
  "num_write_ops": {"min": 6, "max": 6, "step": 1},
  "num_read_ops": {"min": 2, "max": 2, "step": 1},
  "num_keys": {"min": 1, "max": 1, "step": 1},
  "num_crashes": {"min": 2, "max": 2, "step": 1},
  "dependency_density": [0.0],
  "post_fault_client_ops": 2,
  "num_runs_per_config": 1,
  "max_iterations": 600,
  "session_seed": 4343,
  "queue_policy": {"type": "Probabilistic", "p_local": 0.7, "p_timer": 0.2},
  "rng_stream_isolation": true,
  "strict_config_keys": true,
  "stats": true,
  "campaign": {
    "wall_budget_sec": 600,
    "deterministic_slice_runs": 1024,
    "deterministic_rounds": 4,
    "batch_size": 32,
    "allocation": {"kind": "round_robin"},
    "reward": {"kind": "runs"},
    "arms": [{"id": "grid", "mode": "grid"}]
  }
}"#;

const SESSION_STACK_BYTES: usize = 64 * 1024 * 1024;
const PARENT_CANDIDATES: usize = 400;
const BACKUP: i32 = 600;
/// Completed-length samples the span learner is fed, well short of a run, so
/// a placed crash waits inside a run.
const SEEDED_LENGTH: i32 = 30;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("spur_write_ring_{name}"));
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
    0x_C0FF_EE01 ^ run_id as u64
}

fn schedule_seed(run_id: i64) -> u64 {
    0x_5EED_4321 ^ run_id as u64
}

fn run<S: RngSource>(
    program: &spur_core::compiler::cfg::Program,
    run_config: &SingleRunConfig,
    writer: &Arc<dyn HistoryWriter>,
    run_id: i64,
    workload: u64,
    schedule: u64,
    tape: Option<Recording>,
    child: Option<&WriteChild>,
) -> RunResult {
    // The arm selector steers a run only from a cell past its warmup;
    // clearing it before every run keeps each run on its coins.
    spur_core::simulator::arm_selector::reset();
    run_single_simulation::<NoFeedback, S>(
        program,
        writer,
        &GlobalState::<NoFeedback>::new(),
        run_id,
        run_config,
        &Default::default(),
        workload,
        schedule,
        tape,
        child,
        &RunAttribution::mode("test"),
    )
    .expect("the run executes")
}

/// Events by step, without the run id: what a run did and when.
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

/// The events a prefix cut at a client invocation at `cut_step` pins:
/// everything before that step, and the step's invocations, which are
/// issued before the step schedules anything.
fn events_to_cut(dir: &Path, cut_step: i32) -> Vec<Vec<String>> {
    events_through(dir, cut_step)
        .into_iter()
        .filter(|r| r[4].parse::<i32>().expect("step") < cut_step || r[1] == "Invocation")
        .collect()
}

/// The one run row of a single-run directory: `(variant, steps_used,
/// end_reason)`.
fn run_row(dir: &Path) -> (i32, i64, String) {
    let rows = columns(dir, "runs", &["variant", "steps_used", "end_reason"]);
    assert_eq!(rows.len(), 1, "one run writes one row");
    (
        rows[0][0].parse().expect("variant"),
        rows[0][1].parse().expect("steps_used"),
        rows[0][2].clone(),
    )
}

/// The bits a child inherits from its parent: everything the id fixes,
/// without the acted bit and the plan-cell bit that follow the run.
fn inherited(variant: i32) -> i32 {
    variant & !(run_variant::CRASH_HOLD_DRAWN | run_variant::RECOVER_DEPS_EXEMPT)
}

#[test]
fn a_write_child_reproduces_the_signal_under_its_parents_draws() {
    std::thread::Builder::new()
        .stack_size(SESSION_STACK_BYTES)
        .spawn(check_children)
        .expect("spawns the session thread")
        .join()
        .expect("the session thread runs to completion");
}

fn check_children() {
    let _serial = config_override::exclusive_session();
    run_cap::reset();
    fault_timing::reset();
    seed_span();
    util_stats::set_enabled(true);
    let (program, run_config) = compile();
    let eligible = |id: i64| run_variant::probe_bits(id) == 0;
    let parents: Vec<i64> = (0..1_000_000i64)
        .filter(|&id| eligible(id))
        .take(PARENT_CANDIDATES)
        .collect();
    let first_child = parents.last().copied().expect("a parent pool") + 1;

    let mut checked = 0;
    for (i, &parent_id) in parents.iter().enumerate() {
        let parent_dir = scratch(&format!("parent_{i}"));
        let w = writer(&parent_dir);
        let parent = run::<RecordRng>(
            &program,
            &run_config,
            &w,
            parent_id,
            workload_seed(parent_id),
            schedule_seed(parent_id),
            None,
            None,
        );
        w.shutdown();
        let Some(cut) = parent.write_cut else {
            let _ = fs::remove_dir_all(&parent_dir);
            continue;
        };
        let pos = cut.tape_pos.expect("a recording run knows its draw count");
        let tape = parent.recording.expect("a recording run produces a tape");
        assert!(pos > 0, "the signal fired before any draw");
        assert!(
            pos < tape.len(),
            "the request's priority draw follows the cut, so the tape runs past it"
        );
        let prefix: Recording = tape[..pos].into();
        let parent_events = events_to_cut(&parent_dir, cut.step);
        assert!(
            parent_events
                .iter()
                .any(|r| r[1] == "Invocation" && r[4] == cut.step.to_string()),
            "parent {parent_id}: no client operation was invoked at the cut step"
        );
        let (parent_variant, _, _) = run_row(&parent_dir);
        assert_eq!(
            inherited(parent_variant),
            run_variant::from_run_id(parent_id),
            "parent {parent_id}: a coin-drawn run carries its id's bits"
        );

        // A child whose own id names different mechanism bits, so the
        // inherited bits are told apart from the child's own.
        let child_id = (first_child..1_000_000i64)
            .filter(|&id| eligible(id))
            .find(|&id| run_variant::from_run_id(id) != run_variant::from_run_id(parent_id))
            .expect("a child id with other mechanism bits");
        let child = WriteChild {
            parent_run_id: parent_id,
            arms: parent.arms,
            cut_step: cut.step,
            uniform_suffix: false,
        };
        let tournament_dir = scratch(&format!("tournament_{i}"));
        let w = writer(&tournament_dir);
        let tournament = run::<ReplayRng>(
            &program,
            &run_config,
            &w,
            child_id,
            workload_seed(parent_id),
            schedule_seed(child_id),
            Some(prefix.clone()),
            Some(&child),
        );
        w.shutdown();
        assert_eq!(
            tournament.write_cut.map(|c| c.step),
            Some(cut.step),
            "parent {parent_id}: the child did not fire the write signal at the parent's step"
        );
        assert_eq!(
            tournament.write_cut.and_then(|c| c.tape_pos),
            Some(pos),
            "parent {parent_id}: the child stood at another draw when the signal fired"
        );
        assert!(!tournament.uniform_switched, "a tournament child switched");
        assert_eq!(
            parent_events,
            events_to_cut(&tournament_dir, cut.step),
            "parent {parent_id}: the child's events up to the cut at step {} differ",
            cut.step
        );
        let (child_variant, tournament_steps, tournament_end) = run_row(&tournament_dir);
        assert_eq!(
            inherited(child_variant),
            run_variant::from_run_id(parent_id),
            "parent {parent_id}: the child does not carry its parent's mechanism bits"
        );
        assert_ne!(
            inherited(child_variant),
            run_variant::from_run_id(child_id),
            "parent {parent_id}: the child's own bits were chosen to differ"
        );

        // The uniform half switches at the reproduced cut and takes no draw
        // for it: the cut stands at the same draw as the tournament child's.
        let uniform_dir = scratch(&format!("uniform_{i}"));
        let w = writer(&uniform_dir);
        let uniform = run::<ReplayRng>(
            &program,
            &run_config,
            &w,
            child_id,
            workload_seed(parent_id),
            schedule_seed(child_id),
            Some(prefix.clone()),
            Some(&WriteChild {
                uniform_suffix: true,
                ..child
            }),
        );
        w.shutdown();
        assert!(
            uniform.uniform_switched,
            "parent {parent_id}: the uniform child kept the tournament"
        );
        assert_eq!(uniform.write_cut, tournament.write_cut, "the switch moved the cut");
        assert_eq!(
            parent_events,
            events_to_cut(&uniform_dir, cut.step),
            "parent {parent_id}: the uniform child's prefix differs"
        );
        let (uniform_variant, _, _) = run_row(&uniform_dir);
        assert_eq!(uniform_variant, child_variant, "the halves differ in their tag here");

        // A uniform child whose replay does not reach the cut step it was
        // given never switches and is byte-identical to the tournament child.
        let far_dir = scratch(&format!("far_{i}"));
        let w = writer(&far_dir);
        let far = run::<ReplayRng>(
            &program,
            &run_config,
            &w,
            child_id,
            workload_seed(parent_id),
            schedule_seed(child_id),
            Some(prefix.clone()),
            Some(&WriteChild {
                cut_step: cut.step + 100_000,
                uniform_suffix: true,
                ..child
            }),
        );
        w.shutdown();
        assert!(!far.uniform_switched, "a child switched without reproducing the cut");
        assert_eq!(far.write_cut, tournament.write_cut);
        assert_eq!(
            far.recording, tournament.recording,
            "parent {parent_id}: an unswitched uniform child drew differently"
        );
        assert_eq!(
            events_through(&far_dir, i32::MAX),
            events_through(&tournament_dir, i32::MAX),
            "parent {parent_id}: an unswitched uniform child ran differently"
        );
        let (far_variant, far_steps, far_end) = run_row(&far_dir);
        assert_eq!(
            (far_variant, far_steps, far_end),
            (child_variant, tournament_steps, tournament_end)
        );

        for dir in [&parent_dir, &tournament_dir, &uniform_dir, &far_dir] {
            let _ = fs::remove_dir_all(dir);
        }
        checked += 1;
        if checked == 2 {
            break;
        }
    }
    assert!(checked > 0, "no candidate parent fired the write signal");
    let ring = util_stats::snapshot().replay.write_ring;
    assert_eq!(
        ring.signal_runs,
        4 * checked,
        "each checked parent and its three children fire the signal once"
    );
    util_stats::set_enabled(false);
    run_cap::reset();
    fault_timing::reset();
}

#[test]
fn a_campaign_serves_write_slots_and_exports_the_rings_counters() {
    std::thread::Builder::new()
        .stack_size(SESSION_STACK_BYTES)
        .spawn(check_campaign)
        .expect("spawns the session thread")
        .join()
        .expect("the session thread runs to completion");
}

fn u(v: &Value, path: &str) -> u64 {
    let mut cur = v;
    for key in path.split('.') {
        cur = cur
            .get(key)
            .unwrap_or_else(|| panic!("utilization.json lacks {path}"));
    }
    cur.as_u64().unwrap_or_else(|| panic!("{path} is not an integer"))
}

fn check_campaign() {
    let _serial = config_override::exclusive_session();
    run_cap::reset();
    fault_timing::reset();
    let program = compiler::compile(SPEC, "ghost.spur")
        .into_program()
        .expect("spec compiles");
    let config_path = std::env::temp_dir().join("spur_write_ring_campaign.json");
    fs::write(&config_path, CAMPAIGN_CONFIG).expect("writes config");
    let out = scratch("campaign");
    let cancelled = Arc::new(AtomicBool::new(false));
    run_explorer_campaign(
        &program,
        config_path.to_str().expect("utf-8 path"),
        out.to_str().expect("utf-8 path"),
        LogBackend::Parquet,
        &cancelled,
    )
    .expect("campaign runs");
    let _ = fs::remove_file(&config_path);

    // The counters reach the file through this rendering, so it is what a
    // reader of the file sees.
    let text = util_stats::render_snapshot(&util_stats::snapshot()).expect("the snapshot renders");
    let v: Value = serde_json::from_str(&text).expect("the rendered snapshot parses");
    let ring = &v["replay"]["write_ring"];
    let signal_runs = u(ring, "signal_runs");
    let parents = u(ring, "parents_admitted");
    let children = u(ring, "children");
    let faithful = u(ring, "prefix_faithful");
    let fired = u(ring, "children_signal_fired");
    let switched = u(ring, "uniform.switched");
    let not_switched = u(ring, "uniform.not_switched");
    assert!(signal_runs > 0, "no run fired the write signal");
    assert!(
        parents > 0 && parents <= signal_runs,
        "parents {parents} of {signal_runs} signal runs"
    );
    assert!(children > 0, "no write slot ran a write child");
    assert!(
        faithful > 0 && faithful <= fired && fired <= children,
        "{faithful} faithful, {fired} fired, {children} children"
    );
    assert!(u(ring, "cut_step_sum") > 0);
    assert!(u(ring, "child_steps_sum") > 0);
    assert_eq!(u(ring, "write.runs"), children);
    assert!(u(ring, "write.plan_complete") <= children);
    let control = u(ring, "control.runs");
    assert!(control > 0, "no plan-only slot outside the write slots ran a ghost child");
    assert!(u(ring, "control_plan_only_steps_sum") > 0);
    assert!(u(ring, "control.plan_complete") <= control);
    assert!(switched > 0, "no uniform child switched");
    assert!(switched + not_switched <= children);
    assert!(switched <= faithful, "a switch without a faithful replay");
    for half in ["uniform", "tournament"] {
        let base = format!("uniform.first_post_cut_delivery_at_target.{half}");
        let total = u(ring, &format!("{base}.total"));
        assert_eq!(
            u(ring, &format!("{base}.stale")) + u(ring, &format!("{base}.fresh")),
            total,
            "{half}: the classes do not sum"
        );
        assert!(total > 0, "{half}: no first delivery at the target was seen");
    }
    // Ghost-ring children fire the signal too and enter no ring, so the
    // admitted, skipped and write-child firings only bound the total.
    assert!(
        u(ring, "probe_parents_skipped") + parents + fired <= signal_runs,
        "more admissions than signal runs"
    );

    // The bits on the runs table: the write bit lives on half the plan-only
    // slots, the uniform bit on half of those, and neither on a probe.
    let rows = columns(&out, "runs", &["run_id", "variant"]);
    assert!(rows.len() >= 4_000, "the session ran {} runs", rows.len());
    let mut plan_only = 0u64;
    let mut writes = 0u64;
    let mut uniforms = 0u64;
    for row in &rows {
        let run_id: i64 = row[0].parse().expect("run_id");
        let v: i32 = row[1].parse().expect("variant");
        let write = v & run_variant::WRITE_RING_SLOT != 0;
        let uniform = v & run_variant::WRITE_RING_UNIFORM_SUFFIX != 0;
        assert_eq!(write, spur_core::simulator::replay_corpus::is_write_slot(run_id));
        assert_eq!(uniform, spur_core::simulator::replay_corpus::is_uniform_suffix(run_id));
        if v & (run_variant::RUN_CAP_PROBE | run_variant::TIMER_STEER_OFF) != 0 {
            assert!(!write && !uniform, "run {run_id}: a probe carries a write bit");
        }
        if write {
            assert_ne!(
                v & run_variant::REPLAY_SLOT,
                0,
                "run {run_id}: a write slot outside a slot"
            );
            assert_eq!(
                v & run_variant::REPLAY_PREFIX,
                0,
                "run {run_id}: a write slot with a prefix"
            );
        }
        if uniform {
            assert!(write, "run {run_id}: the uniform bit without the write bit");
        }
        if v & run_variant::REPLAY_SLOT != 0 && v & run_variant::REPLAY_PREFIX == 0 {
            plan_only += 1;
            writes += write as u64;
            uniforms += uniform as u64;
        }
    }
    let write_share = writes as f64 / plan_only.max(1) as f64;
    assert!(
        (0.4..0.6).contains(&write_share),
        "write slots take {write_share} of the plan-only slots"
    );
    let uniform_share = uniforms as f64 / writes.max(1) as f64;
    assert!(
        (0.4..0.6).contains(&uniform_share),
        "uniform slots take {uniform_share} of the write slots"
    );

    // Enabling the counters again starts the ring's block from zero.
    util_stats::set_enabled(true);
    let fresh = util_stats::snapshot().replay.write_ring;
    assert_eq!(fresh.signal_runs, 0);
    assert_eq!(fresh.parents_admitted, 0);
    assert_eq!(fresh.children, 0);
    assert_eq!(fresh.slots_unfilled, 0);
    assert_eq!(fresh.prefix_faithful, 0);
    assert_eq!(fresh.cut_step_sum, 0);
    assert_eq!(fresh.child_steps_sum, 0);
    assert_eq!(fresh.control_plan_only_steps_sum, 0);
    assert_eq!(fresh.write.runs, 0);
    assert_eq!(fresh.control.runs, 0);
    assert_eq!(fresh.uniform.switched, 0);
    assert_eq!(fresh.uniform.not_switched, 0);
    assert_eq!(fresh.uniform.first_post_cut_delivery_at_target.uniform.total, 0);
    assert_eq!(fresh.uniform.first_post_cut_delivery_at_target.tournament.total, 0);
    util_stats::set_enabled(false);
    let _ = fs::remove_dir_all(&out);
    run_cap::reset();
    fault_timing::reset();
}
