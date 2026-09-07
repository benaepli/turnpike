use super::eval_parity;
use super::state::{Runnable, State};
use super::values::eval_accounting;
use crate::compiler;
use crate::simulator::explorer::{ExplorerConfig, GlobalState, NoFeedback, RunAttribution, run_single_simulation_with_hash};
use crate::simulator::hash_utils::{HashPolicy, NoHashing, WithHashing};
use crate::simulator::history::{HistoryWriter, PersistableLog, PersistableOp, PersistableRun, PersistableTrace};
use crate::simulator::rng::{RecordRng, Recording, ReplayRng, RngSource, SCHEDULE_SALT, WORKLOAD_SALT, derive_seed};
use crate::simulator::{arm_selector, fault_timing, run_cap, timer_context, util_stats};
use serde_json::{Value as Json, json};
use std::cell::{Cell, RefCell};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
thread_local! {
    static ENVIRONMENTS: RefCell<Vec<Json>> = const { RefCell::new(Vec::new()) };
    static CAPTURE_WRITES: Cell<bool> = const { Cell::new(false) };
    static WRITES: RefCell<Vec<Json>> = const { RefCell::new(Vec::new()) };
}

pub(crate) fn capture_write<H: HashPolicy>(slot: u32, value: &super::values::Value<H>, env: &super::values::Env<H>) {
    if CAPTURE_WRITES.get() {
        WRITES.with_borrow_mut(|rows| rows.push(json!([slot,format!("{:?}",value.kind),value.sig,env.sig,env.writes])));
    }
}

pub(crate) fn capture_state<H: HashPolicy>(run_id: i64, state: &State<H>) {
    let mut records = Vec::new();
    let mut capture = |location: String, runnable: &Runnable<H>| {
        if let Runnable::Record(record) = runnable {
            records.push(json!([location, format!("{:?}", record)]));
        }
    };
    for (node, queue) in state.local_queues.iter().enumerate() {
        for (index, runnable) in queue.iter().enumerate() { capture(format!("local:{node}:{index}"), runnable); }
    }
    for (index, runnable) in state.network_queue.iter().enumerate() { capture(format!("network:{index}"), runnable); }
    for (index, runnable) in state.timer_queue.iter().enumerate() { capture(format!("timer:{index}"), runnable); }
    for (index, (_, runnable)) in state.purgatory.iter().enumerate() { capture(format!("purgatory:{index}"), runnable); }
    let mut channels: Vec<_> = state.channels.iter().collect();
    channels.sort_by_key(|(id, _)| **id);
    let channels: Vec<_> = channels.into_iter().map(|(id, channel)| json!([format!("{id:?}"),format!("{channel:?}")])).collect();
    let mut persisted: Vec<_> = state.persisted_data.iter().collect();
    persisted.sort_by_key(|(node, _)| **node);
    let persisted: Vec<_> = persisted.into_iter().map(|(node, value)| json!([node,format!("{value:?}")])).collect();
    ENVIRONMENTS.with_borrow_mut(|rows| rows.push(json!({
        "run": run_id,
        "nodes": format!("{:?}",state.nodes),
        "records": records,
        "channels": channels,
        "persisted": persisted,
        "crashed_records": format!("{:?}",state.crash_info.queued_messages),
    })));
}

#[derive(Default)]
struct Writer(Mutex<Vec<Json>>);
impl HistoryWriter for Writer {
    fn write(&self, run_id: i64, history: Vec<PersistableOp>, logs: Vec<PersistableLog>, traces: Vec<PersistableTrace>) {
        let ops: Vec<_> = history.into_iter().enumerate().map(|(seq, r)| json!([
            run_id,seq,r.unique_id,r.client_id,r.kind,r.action,r.payload_json,r.step
        ])).collect();
        let logs: Vec<_> = logs.into_iter().enumerate().map(|(seq,r)| json!([
            run_id,seq,r.node_id,r.content,r.step
        ])).collect();
        let traces: Vec<_> = traces.into_iter().enumerate().map(|(seq,r)| json!([
            run_id,seq,r.node_id,r.step,r.function_name.as_ref(),r.trace_kind,r.payload,
            r.schedulable_count,r.trace_id,r.causal_operation_id
        ])).collect();
        self.0.lock().unwrap().push(json!({"executions":ops,"logs":logs,"traces":traces}));
    }
    fn write_run(&self, r: PersistableRun) {
        self.0.lock().unwrap().push(json!({"run":[
            r.run_id,r.arm,r.arm_index,r.config_index,r.workload_seed,r.schedule_seed,
            r.steps_used,r.end_reason,r.timers_fired,r.timers_acted,r.timers_inflight_fired,
            r.timers_inflight_acted,r.timers_idle_fired,r.timers_idle_acted,r.max_inert_streak,r.variant
        ]}));
    }
    fn shutdown(&self) {}
}

fn worker<H: HashPolicy, S: RngSource>() {
    let input = PathBuf::from(std::env::var("SPUR_PARITY_INPUT").unwrap());
    let output = PathBuf::from(std::env::var("SPUR_PARITY_OUTPUT").unwrap());
    let reference = std::env::var("SPUR_PARITY_ENGINE").unwrap() == "reference";
    let descriptor: Json = serde_json::from_slice(&fs::read(input).unwrap()).unwrap();
    let config: ExplorerConfig = serde_json::from_value(descriptor["config"].clone()).unwrap();
    let source = fs::read_to_string(descriptor["spec"].as_str().unwrap()).unwrap();
    let program = compiler::compile(&source,descriptor["spec"].as_str().unwrap()).into_program().unwrap();
    let run_config = config.expand_grid();
    assert_eq!(run_config.len(),1);
    let tapes: Option<Json> = std::env::var("SPUR_PARITY_REPLAY").ok().map(|path| serde_json::from_slice(&fs::read(path).unwrap()).unwrap());
    run_cap::reset(); arm_selector::reset(); fault_timing::reset(); timer_context::reset();
    fault_timing::set_fraction(config.faults.crash_placement_fraction);
    util_stats::set_enabled(config.stats);
    util_stats::set_acted_fraction_enabled(config.emit_acted_fraction);
    util_stats::set_acceptance_distance_enabled(config.emit_acceptance_distance);
    util_stats::set_crash_census_enabled(config.emit_crash_census);
    util_stats::set_quiet_stretch_enabled(config.quiet_stretch_telemetry);
    util_stats::set_prefix_extension_enabled(config.emit_prefix_extension);
    util_stats::set_steer_audit_enabled(config.feedback.steer_audit);
    util_stats::set_steer_audit_always(config.feedback.steer_audit_always);
    util_stats::set_multiplier_audit_enabled(config.emit_multiplier_authority);
    util_stats::set_recovery_weight_placebo(config.faults.recovery_weight_placebo);
    let writer = Arc::new(Writer::default());
    let sink: Arc<dyn HistoryWriter> = writer.clone();
    let global = GlobalState::<NoFeedback>::new();
    let mut recordings = Vec::new();
    let mut outcomes = Vec::new();
    CAPTURE_WRITES.set(true);
    eval_parity::select(reference);
    eval_accounting::reset();
    for (run_id, config_index) in crate::simulator::explorer::grid_order(1,config.num_runs_per_config,false) {
        let tape: Option<Recording> = tapes.as_ref().map(|data| {
            data["tapes"][(run_id - 1) as usize].as_array().unwrap().iter()
                .map(|word| word.as_u64().unwrap()).collect::<Vec<_>>().into()
        });
        let result = run_single_simulation_with_hash::<H,NoFeedback,S>(
            &program,&sink,&global,run_id,&run_config[0],&config.feedback.weights,
            derive_seed(config.session_seed,run_id,WORKLOAD_SALT),
            derive_seed(config.session_seed,run_id,SCHEDULE_SALT),tape,
            &RunAttribution::mode("standard").with_config(config_index),
        ).unwrap();
        recordings.push(result.recording.unwrap().to_vec());
        outcomes.push(format!("{:?}",result.outcome));
    }
    CAPTURE_WRITES.set(false);
    let counts = eval_accounting::snapshot();
    let mut stats = util_stats::snapshot_value();
    stats.as_object_mut().unwrap().remove("eval_transient");
    let result = json!({
        "rows": *writer.0.lock().unwrap(), "tapes": recordings, "outcomes": outcomes,
        "environments": ENVIRONMENTS.with_borrow(Clone::clone), "writes": WRITES.with_borrow(Clone::clone), "stats":stats, "counts":counts,
    });
    fs::write(output,serde_json::to_vec(&result).unwrap()).unwrap();
}

#[test]
fn protocol_worker() {
    if std::env::var_os("SPUR_PARITY_INPUT").is_none() { return; }
    std::thread::Builder::new().stack_size(64 * 1024 * 1024).spawn(|| {
        match (std::env::var("SPUR_PARITY_HASH").unwrap().as_str(),std::env::var_os("SPUR_PARITY_REPLAY").is_some()) {
            ("NoHashing",false) => worker::<NoHashing,RecordRng>(),
            ("NoHashing",true) => worker::<NoHashing,ReplayRng>(),
            ("WithHashing",false) => worker::<WithHashing,RecordRng>(),
            ("WithHashing",true) => worker::<WithHashing,ReplayRng>(),
            _ => panic!("invalid hashing policy"),
        }
    }).unwrap().join().unwrap();
}

fn run_worker(input: &Path, output: &Path, hash: &str, reference: bool, replay: Option<&Path>) -> Json {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--exact","simulator::core::eval_protocol_parity::protocol_worker","--test-threads=1"])
        .env("SPUR_PARITY_INPUT",input).env("SPUR_PARITY_OUTPUT",output)
        .env("SPUR_PARITY_HASH",hash).env("SPUR_PARITY_ENGINE",if reference {"reference"} else {"candidate"});
    if let Some(replay) = replay { command.env("SPUR_PARITY_REPLAY",replay); }
    let result = command.output().unwrap();
    assert!(result.status.success(),"worker failed: {} {}",String::from_utf8_lossy(&result.stdout),String::from_utf8_lossy(&result.stderr));
    serde_json::from_slice(&fs::read(output).unwrap()).unwrap()
}

fn assert_identity(reference: &Json, candidate: &Json, name: &str) {
    for field in ["rows","tapes","outcomes","environments","writes","stats"] {
        assert!(reference[field] == candidate[field],"{name}: {field} mismatch");
    }
}

fn compare_cell(directory: &Path, name: &str, spec: &Path, config: Json, hash: &str) -> Json {
    let descriptor = directory.join(format!("{name}.input.json"));
    fs::write(&descriptor,serde_json::to_vec(&json!({"spec":spec,"config":config})).unwrap()).unwrap();
    let reference_file = directory.join(format!("{name}.reference.json"));
    let reference = run_worker(&descriptor,&reference_file,hash,true,None);
    let candidate = run_worker(&descriptor,&directory.join(format!("{name}.candidate.json")),hash,false,None);
    assert_identity(&reference,&candidate,name);
    let reference_replay = run_worker(&descriptor,&directory.join(format!("{name}.reference-replay.json")),hash,true,Some(&reference_file));
    let candidate_replay = run_worker(&descriptor,&directory.join(format!("{name}.candidate-replay.json")),hash,false,Some(&reference_file));
    assert_identity(&reference,&reference_replay,&format!("{name} reference replay"));
    assert_identity(&reference,&candidate_replay,&format!("{name} candidate replay"));
    json!({"cell":name,"reference":reference["counts"],"candidate":candidate["counts"],
        "reference_replay":reference_replay["counts"],"candidate_replay":candidate_replay["counts"]})
}

#[test]
fn frozen_protocol_corpus() {
    let root = Path::new(ROOT);
    let profile = if cfg!(debug_assertions) {"debug"} else {"release"};
    let directory = root.join(format!("tmp/loop/eval-parity/{profile}"));
    fs::create_dir_all(&directory).unwrap();
    let bench: Json = serde_json::from_slice(&fs::read(root.join("scheduler_configs/loop/bench.json")).unwrap()).unwrap();
    let mut cells = Vec::new();
    for protocol in ["VR","Paxos","Raft"] {
        for seed in 1000..=1002 {
            for hash in ["NoHashing","WithHashing"] {
                let mut config = bench.clone();
                config["num_runs_per_config"] = json!(64);
                config["max_iterations"] = json!(1500);
                config["stats"] = json!(true);
                config["session_seed"] = json!(seed);
                let name = format!("{protocol}-{seed}-{hash}");
                let cell = compare_cell(&directory,&name,&root.join(format!("bin/spur/{protocol}.spur")),config,hash);
                eprintln!("{cell}"); cells.push(cell);
            }
        }
    }
    let total = |engine: &str| cells.iter().map(|cell| cell[engine]["constructions"].as_u64().unwrap() + cell[engine]["clones"].as_u64().unwrap()).sum::<u64>();
    let reference = total("reference");
    let candidate = total("candidate");
    let report = json!({"cells":cells,"reference_total":reference,"candidate_total":candidate,"reduction":1.0-candidate as f64/reference as f64});
    fs::write(directory.join("counts.json"),serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    eprintln!("protocol reference={reference} candidate={candidate}");
    assert!(candidate * 4 <= reference * 3,"construction plus clone reduction is below 25%: {report}");
}

#[test]
fn fixture_program_evaluator_parity() {
    let root = Path::new(ROOT);
    let profile = if cfg!(debug_assertions) {"debug"} else {"release"};
    let directory = root.join(format!("tmp/loop/eval-parity/{profile}/fixtures"));
    fs::create_dir_all(&directory).unwrap();
    let config = json!({
        "num_servers":{"min":3,"max":3,"step":1},"num_write_ops":{"min":3,"max":3,"step":1},
        "num_read_ops":{"min":2,"max":2,"step":1},"num_keys":{"min":1,"max":1,"step":1},
        "num_crashes":{"min":2,"max":2,"step":1},"dependency_density":[0.0],
        "num_runs_per_config":6,"max_iterations":600,"session_seed":1000,"stats":true
    });
    for fixture in ["timer","relay","kv","mapiter","fanout","ghost"] {
        for hash in ["NoHashing","WithHashing"] {
            let name = format!("{fixture}-{hash}");
            compare_cell(&directory,&name,&root.join(format!("spur/spur-core/tests/fixtures/{fixture}.spur")),config.clone(),hash);
        }
    }
}
