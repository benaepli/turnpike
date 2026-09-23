//! Offline analysis of per-run time-constraint records, and the regression
//! harness of the `spur-time` engine.
//!
//! check           rebuild every value and comparison from its record
//! classify        bucket each constraint by its linear form
//! general         the run through Z3 with less of it fixed
//! threads         the same on several threads
//! linear          each run's script through the engine or an SMT solver,
//!                 its answers checked against Z3 or the exact engine
//! linear-threads  the same on several threads, timed
//! slowest         the runs the engine is slowest on, beside the SMT solvers
//! anchors         whether fixing the scale of open durations changes answers
//! liveness        when time unknowns die by the record's drop signal, against
//!                 their last mention, and how reads group into steps
//! agree           an online engine log (`--tc` names its directory) against
//!                 Z3, decision by decision
//! cycling         the runs in which a check cycles, the shortest written out
//! patterns        joint (node, site, result) patterns of the runs' time
//!                 comparisons: how many distinct, how many runs had one
//!                 site come out true, or false, on two nodes, and each
//!                 site's operation
//! witness         a whole-tick timeline for each run from its rows alone,
//!                 re-evaluated with floor readings: does every outcome and
//!                 fire survive
//!                 as test fixtures with Z3's answers (`SYMTIME_DUMP_DIR`)

mod agree;
mod drive;
mod dump;
mod general;
mod linear;
mod model;
#[cfg(feature = "with-yices")]
mod smt_yices;
mod smt_z3;

use drive::{Outcome, Policy};
use model::{Run, Shape};
use spur_time::Arithmetic;
use std::collections::BTreeMap;
use std::path::PathBuf;

struct Args {
    command: String,
    tc: PathBuf,
    walls: Option<PathBuf>,
    limit: usize,
    emit_count: usize,
    forget: bool,
    level: String,
    timeout: u32,
    backend: String,
    against: String,
    threads: usize,
}

fn args() -> Args {
    let mut it = std::env::args().skip(1);
    let command = it.next().expect("a command");
    let mut a = Args {
        command,
        tc: PathBuf::new(),
        walls: None,
        limit: usize::MAX,
        emit_count: 200,
        forget: false,
        level: "concrete".into(),
        timeout: 1000,
        backend: "z3".into(),
        against: "z3".into(),
        threads: 1,
    };
    while let Some(flag) = it.next() {
        let value = it.next().expect("a value for the flag");
        match flag.as_str() {
            "--tc" => a.tc = value.into(),
            "--walls" => a.walls = Some(value.into()),
            "--limit" => a.limit = value.parse().unwrap(),
            "--emit-count" => a.emit_count = value.parse().unwrap(),
            // Whether answers are checked against a reference.
            "--forget" => a.forget = value == "true",
            "--level" => a.level = value,
            "--timeout" => a.timeout = value.parse().unwrap(),
            "--backend" => a.backend = value,
            "--against" => a.against = value,
            "--threads" => a.threads = value.parse().unwrap(),
            other => panic!("unknown flag {other}"),
        }
    }
    a
}

fn load(args: &Args) -> Vec<Run> {
    let mut runs = Vec::new();
    let mut files: Vec<_> = std::fs::read_dir(&args.tc)
        .expect("the record directory")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .collect();
    files.sort();
    for file in files {
        let text = std::fs::read_to_string(&file).unwrap();
        for line in text.lines() {
            if runs.len() >= args.limit {
                break;
            }
            let json: serde_json::Value = serde_json::from_str(line).unwrap();
            runs.push(Run::parse(&json));
        }
    }
    runs.sort_by_key(|r| r.id);
    runs
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let index = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[index]
}

fn check(runs: &[Run]) {
    let (mut values, mut comparisons, mut deadlines, mut bad, mut unknown) = (0u64, 0u64, 0u64, 0u64, 0u64);
    for run in runs {
        unknown += run.unknown;
        let times: Vec<i128> = run.segment_times();
        let report = run.evaluate(&times);
        values += report.values;
        comparisons += report.comparisons;
        deadlines += report.deadlines;
        bad += report.value_mismatches + report.flipped + report.deadline_mismatches + report.ineligible;
    }
    println!("runs {}", runs.len());
    println!("values rebuilt {values}, comparisons {comparisons}, deadlines {deadlines}");
    println!("mismatches {bad}");
    println!("operands of unknown origin {unknown}");
}

fn patterns_pass(runs: &[Run]) {
    let mut patterns: std::collections::BTreeSet<Vec<(Option<usize>, usize, bool)>> = Default::default();
    let mut ops: BTreeMap<usize, String> = BTreeMap::new();
    let (mut two_nodes, mut two_false) = (0u64, 0u64);
    for run in runs {
        let mut joint: std::collections::BTreeSet<(Option<usize>, usize, bool)> = Default::default();
        for (node, site, op, result) in run.comparisons() {
            ops.insert(site, op);
            joint.insert((node, site, result));
        }
        let mut held: BTreeMap<(usize, bool), std::collections::BTreeSet<Option<usize>>> = BTreeMap::new();
        for (node, site, result) in &joint {
            held.entry((*site, *result)).or_default().insert(*node);
        }
        two_nodes += u64::from(held.iter().any(|((_, r), n)| *r && n.len() >= 2));
        two_false += u64::from(held.iter().any(|((_, r), n)| !*r && n.len() >= 2));
        patterns.insert(joint.into_iter().collect());
    }
    println!("runs {}", runs.len());
    println!("distinct joint patterns {}", patterns.len());
    println!("runs with one site true on two nodes {two_nodes}");
    println!("runs with one site false on two nodes {two_false}");
    println!("ops {}", serde_json::to_string(&ops).unwrap());
}

fn witness_pass(runs: &[Run]) {
    let mut tally: BTreeMap<&'static str, u64> = BTreeMap::new();
    let mut moved = 0u64;
    let mut walls: Vec<f64> = Vec::new();
    for run in runs {
        let (unknowns, rows) = match run.witness_rows() {
            Ok(r) => r,
            Err(why) => {
                *tally.entry(why).or_default() += 1;
                continue;
            }
        };
        let start = std::time::Instant::now();
        let solved = spur_time::witness::witness(spur_time::Options::default(), unknowns, &rows);
        walls.push(start.elapsed().as_secs_f64() * 1e3);
        let outcome = match solved {
            Err(failure) => failure.reason(),
            Ok(times) => {
                moved += u64::from(times != run.segment_times());
                let report = run.evaluate_outcomes(&times);
                if report.flipped > 0 {
                    "replay_flipped"
                } else if report.ineligible > 0 {
                    "replay_ineligible"
                } else {
                    "replayed"
                }
            }
        };
        *tally.entry(outcome).or_default() += 1;
    }
    walls.sort_by(f64::total_cmp);
    let unsupported: u64 = ["unknown_origin", "unassigned_duration"].iter().map(|k| tally.get(k).copied().unwrap_or(0)).sum();
    let supported = runs.len() as u64 - unsupported;
    let replayed = tally.get("replayed").copied().unwrap_or(0);
    println!("runs {} supported {supported}", runs.len());
    for (k, v) in &tally {
        println!("  {k} {v}");
    }
    println!("replayed share {:.4}, timelines moved {moved}", replayed as f64 / supported.max(1) as f64);
    println!("solve ms p50 {:.2} p99 {:.2} max {:.2}", percentile(&walls, 0.5), percentile(&walls, 0.99), walls.last().copied().unwrap_or(0.0));
}

fn classify(runs: &[Run]) {
    let mut executed: BTreeMap<(&'static str, Shape), u64> = BTreeMap::new();
    let mut sites: BTreeMap<(usize, Shape), u64> = BTreeMap::new();
    for run in runs {
        for con in run.constraints() {
            let shape = con.shape(run);
            *executed.entry((con.what(), shape)).or_default() += 1;
            if let Some(site) = con.site() {
                *sites.entry((site, shape)).or_default() += 1;
            }
        }
    }
    println!("runs {}", runs.len());
    println!("executed constraints by kind and shape:");
    for ((what, shape), n) in &executed {
        println!("  {what:<10} {shape:?}: {n}");
    }
    let total: u64 = executed.iter().filter(|((w, _), _)| *w == "comparison").map(|(_, n)| n).sum();
    let two: u64 = executed
        .iter()
        .filter(|((w, s), _)| *w == "comparison" && matches!(s, Shape::TwoPoint | Shape::Constant))
        .map(|(_, n)| n)
        .sum();
    if total > 0 {
        println!("comparisons in two-point or constant form: {two}/{total} = {:.2}%", 100.0 * two as f64 / total as f64);
    }
    println!("comparison sites by shape:");
    for ((site, shape), n) in &sites {
        println!("  site {site}: {shape:?} x{n}");
    }
}

fn level_of(args: &Args) -> general::Level {
    match args.level.as_str() {
        "concrete" => general::Level::Concrete,
        "durations" => general::Level::Durations,
        "rates" => general::Level::Rates,
        "both" => general::Level::Both,
        "naive" => general::Level::Naive,
        other => panic!("unknown level {other}"),
    }
}

fn walls_of(args: &Args) -> BTreeMap<i64, f64> {
    args.walls
        .as_ref()
        .map(|p| {
            std::fs::read_to_string(p)
                .unwrap()
                .lines()
                .filter_map(|l| {
                    let mut it = l.split_whitespace();
                    Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn rho() -> num_rational::Ratio<i128> {
    num_rational::Ratio::new(5i128, 100i128)
}

/// `SYMTIME_SCALE`: every value of every unknown multiplied by this, as a
/// rational `n/d` or an integer.
fn scale_of() -> Option<spur_time::Q> {
    rational_of(&std::env::var("SYMTIME_SCALE").ok()?)
}

fn rational_of(text: &str) -> Option<spur_time::Q> {
    Some(match text.split_once('/') {
        Some((n, d)) => spur_time::Q::new(n.parse().ok()?, d.parse().ok()?),
        None => spur_time::Q::from_integer(text.parse().ok()?),
    })
}

fn script_of(run: &Run, level: general::Level) -> linear::Script {
    let script = linear::script(run, level, &rho());
    match scale_of() {
        Some(by) => drive::scaled(script, by),
        None => script,
    }
}

/// The engine's policy for a run. `SYMTIME_FLOAT_FLOOR` sets the magnitude
/// below which float values are compared absolutely; one tick when unset.
/// `SIMPLEX_SETTLE_ROUNDS` bounds the rounds one acceptance moves the
/// durations in. `SYMTIME_UNIT` names the run's unit of time, a rational
/// written `n/d`.
fn policy_for(_run: &Run, backend: &str) -> Policy {
    let mut policy = Policy::from_env(backend);
    if let Some(floor) = std::env::var("SYMTIME_FLOAT_FLOOR").ok().and_then(|v| v.parse().ok()) {
        policy.opts.float_scale = floor;
    }
    if let Some(unit) = std::env::var("SYMTIME_UNIT").ok().and_then(|v| rational_of(&v)) {
        policy.opts.unit = unit;
    }
    if let Some(rounds) = std::env::var("SIMPLEX_SETTLE_ROUNDS").ok().and_then(|v| v.parse().ok()) {
        policy.opts.settle_rounds = rounds;
    }
    policy
}

/// The run through Z3 with less of it fixed, one context for all runs.
fn general_pass(runs: &[Run], args: &Args) {
    let level = level_of(args);
    let walls = walls_of(args);
    let ctx = z3::Context::new(&z3::Config::new());
    let solver = general::solver(&ctx, level, args.timeout);
    let rho = rho();
    let mut ns = Vec::new();
    let mut ratios = Vec::new();
    let (mut comparisons, mut open_count, mut undecided, mut inconsistent, mut undivided) = (0u64, 0u64, 0u64, 0u64, 0u64);
    for run in runs {
        let start = std::time::Instant::now();
        let outcome = general::play(&ctx, &solver, run, level, &rho);
        let elapsed = start.elapsed().as_nanos() as f64;
        if outcome.open.is_empty() {
            continue;
        }
        ns.push(elapsed);
        if let Some(wall_us) = walls.get(&run.id) {
            if *wall_us > 0.0 {
                ratios.push(elapsed / (wall_us * 1000.0));
            }
        }
        inconsistent += u64::from(!outcome.consistent);
        undivided += outcome.undivided;
        for flippable in &outcome.open {
            comparisons += 1;
            match flippable {
                Some(true) => open_count += 1,
                None => undecided += 1,
                _ => {}
            }
        }
    }
    ns.sort_by(f64::total_cmp);
    ratios.sort_by(f64::total_cmp);
    println!("z3, level {:?}, runs {} (with comparisons {})", level, runs.len(), ns.len());
    println!("comparisons {comparisons}, other outcome open {open_count}, undecided within {} ms {undecided}", args.timeout);
    println!("runs whose taken outcomes the solver did not confirm {inconsistent}; constraints left in the undivided form {undivided}");
    println!("solver ns per run: median {:.0} p99 {:.0} max {:.0}", percentile(&ns, 0.5), percentile(&ns, 0.99), percentile(&ns, 1.0));
    if !ratios.is_empty() {
        println!("solver time over the run's own wall time: median {:.3} p99 {:.3} max {:.3}", percentile(&ratios, 0.5), percentile(&ratios, 0.99), percentile(&ratios, 1.0));
    }
}

/// The run through Z3 on `--threads` threads, a context per thread.
fn threads_pass(runs: &[Run], args: &Args) {
    let level = level_of(args);
    let rho = rho();
    let chunk = runs.len().div_ceil(args.threads);
    let start = std::time::Instant::now();
    let open: u64 = std::thread::scope(|scope| {
        let handles: Vec<_> = runs
            .chunks(chunk)
            .map(|part| {
                let rho = &rho;
                scope.spawn(move || {
                    let ctx = z3::Context::new(&z3::Config::new());
                    let solver = general::solver(&ctx, level, 1000);
                    part.iter().map(|run| general::play(&ctx, &solver, run, level, rho).open.iter().filter(|o| **o == Some(true)).count() as u64).sum::<u64>()
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).sum()
    });
    let seconds = start.elapsed().as_secs_f64();
    println!("z3 level {:?} threads {:>2}: {:>8.0} runs/s, open outcomes {open}", level, args.threads, runs.len() as f64 / seconds);
}

/// Plays one script by `backend`: `simplex` and `float` through the engine.
fn play_by(backend: &str, script: linear::Script, policy: &Policy, ctx: &z3::Context, z3_solver: &z3::Solver) -> Outcome {
    match backend {
        "z3" => smt_z3::play(ctx, z3_solver, &script),
        "simplex" | "float" => drive::play(script, policy),
        other => panic!("unknown backend {other}"),
    }
}

/// Plays each run's linear script, checks the answers against a reference
/// when asked, and reports cost against the run itself.
fn linear_pass(runs: &[Run], args: &Args) {
    let level = level_of(args);
    let walls = walls_of(args);
    let rho = rho();
    let verify = args.forget;
    let mut worst = (0u128, 0i64, 0u64, 0usize, 0usize);
    let mut wrong = 0u64;
    let (mut widened, mut conceded_runs, mut unanswered, mut lost, mut undecided) = (0u64, 0u64, 0u64, 0u64, 0u64);
    // Open where the reference says closed, closed where it says open, and
    // the reference's open and closed counts.
    let mut tally = (0u64, 0u64, 0u64, 0u64);
    let ctx = z3::Context::new(&z3::Config::new());
    let reference = general::solver(&ctx, level, 1000);
    let z3_solver = general::solver(&ctx, level, 10_000);
    let (mut ns, mut ratios, mut pivots, mut peaks) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let (mut comparisons, mut open_count, mut rejected, mut unsupported, mut disagreements, mut cycling) = (0u64, 0u64, 0u64, 0u64, 0u64, 0u64);
    // SYMTIME_ONLY=index keeps one run of the batch, to look at it alone.
    let only: Option<usize> = std::env::var("SYMTIME_ONLY").ok().and_then(|v| v.parse().ok());
    for (index, run) in runs.iter().enumerate() {
        if only.is_some_and(|o| o != index) {
            continue;
        }
        let script = script_of(run, level);
        let policy = policy_for(run, &args.backend);
        unsupported += script.unsupported;
        let mut best = u128::MAX;
        let mut outcome = None;
        for _ in 0..(if args.backend == "simplex" || args.backend == "float" { 3 } else { 1 }) {
            let copy = script.clone();
            let start = std::time::Instant::now();
            let o = play_by(&args.backend, copy, &policy, &ctx, &z3_solver);
            best = best.min(start.elapsed().as_nanos());
            outcome = Some(o);
        }
        let outcome = outcome.unwrap();
        peaks.push(outcome.report.peak_rows as f64);
        if outcome.open.is_empty() {
            continue;
        }
        if best > worst.0 {
            worst = (best, run.id, outcome.report.pivots, outcome.report.peak_rows, outcome.open.len());
        }
        ns.push(best as f64);
        pivots.push(outcome.report.pivots as f64);
        if let Some(wall_us) = walls.get(&run.id) {
            if *wall_us > 0.0 {
                ratios.push(best as f64 / (wall_us * 1000.0));
            }
        }
        rejected += outcome.report.rejected;
        widened += u64::from(outcome.report.widened > 0);
        conceded_runs += u64::from(outcome.conceded());
        cycling += outcome.report.cycling_checks;
        unanswered += outcome.unanswered() as u64;
        lost += u64::from(outcome.report.continuation == Some(false));
        comparisons += outcome.open.len() as u64;
        open_count += outcome.open.iter().filter(|o| **o == Some(true)).count() as u64;
        if verify {
            let exact: Vec<Option<bool>> = if args.against == "exact" {
                let mut exact_policy = policy;
                exact_policy.opts.arithmetic = Arithmetic::Exact;
                exact_policy.draw = None;
                drive::play(script.clone(), &exact_policy).open
            } else {
                general::play(&ctx, &reference, run, level, &rho).open
            };
            // A comparison left without an answer has nothing to compare,
            // and nor has one the reference gave up on.
            undecided += exact.iter().zip(&outcome.open).filter(|(a, b)| b.is_some() && a.is_none()).count() as u64;
            let differing = exact.iter().zip(&outcome.open).filter(|(a, b)| b.is_some() && a.is_some() && a != b).count() as u64;
            let (wrong_open, wrong_closed) = exact.iter().zip(&outcome.open).fold((0u64, 0u64), |(o, c), (a, b)| match (a, b) {
                (Some(false), Some(true)) => (o + 1, c),
                (Some(true), Some(false)) => (o, c + 1),
                _ => (o, c),
            });
            tally.0 += wrong_open;
            tally.1 += wrong_closed;
            tally.2 += exact.iter().filter(|a| **a == Some(true)).count() as u64;
            tally.3 += exact.iter().filter(|a| **a == Some(false)).count() as u64;
            if only.is_some() {
                for (at, (a, b)) in exact.iter().zip(&outcome.open).enumerate() {
                    if a != b {
                        println!("comparison {at} site {:?}: reference {a:?}, this solver {b:?}", outcome.sites[at]);
                    }
                }
            }
            if differing > 0 || exact.len() != outcome.open.len() {
                disagreements += 1;
                println!("run {index} differs from the reference");
            }
            wrong += differing;
        }
    }
    for v in [&mut ns, &mut ratios, &mut pivots, &mut peaks] {
        v.sort_by(f64::total_cmp);
    }
    println!("backend {}, level {:?}, runs {} (with comparisons {})", args.backend, level, runs.len(), ns.len());
    println!("comparisons {comparisons}, other outcome open {open_count}");
    println!("taken outcomes rejected {rejected}, runs widened {widened}, runs that conceded {conceded_runs}, rows this level cannot write {unsupported}, checks that cycled {cycling}");
    println!("comparisons without an answer {unanswered}, runs with no point to go on from {lost}");
    if verify {
        let name = if args.against == "exact" { "the exact engine" } else { "Z3" };
        println!("runs whose answers differ from {name} {disagreements} ({wrong} comparisons)");
        println!("open where the reference says closed {} of {} closed, closed where it says open {} of {} open", tally.0, tally.3, tally.1, tally.2);
        println!("comparisons the reference gave up on {undecided}");
    }
    println!("slowest run {}: {:.1} ms, {} pivots, {} peak rows, {} comparisons", worst.1, worst.0 as f64 / 1e6, worst.2, worst.3, worst.4);
    println!("ns per run: median {:.0} p99 {:.0} max {:.0}", percentile(&ns, 0.5), percentile(&ns, 0.99), percentile(&ns, 1.0));
    println!("peak tableau rows: median {:.0} p99 {:.0} max {:.0}", percentile(&peaks, 0.5), percentile(&peaks, 0.99), percentile(&peaks, 1.0));
    println!("pivots per run: median {:.0} p99 {:.0} max {:.0}", percentile(&pivots, 0.5), percentile(&pivots, 0.99), percentile(&pivots, 1.0));
    if !ratios.is_empty() {
        println!("time over the run's own wall time: median {:.4} p99 {:.4} max {:.4}", percentile(&ratios, 0.5), percentile(&ratios, 0.99), percentile(&ratios, 1.0));
    }
}

/// Every run's script played on `--threads` worker threads. Each worker owns
/// its engine and takes the next unplayed run from a shared counter. Scripts
/// are built beforehand and are not timed.
fn linear_threads(runs: &[Run], args: &Args) {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    let level = level_of(args);
    // SYMTIME_ONLY=index keeps one run of the batch, to look at it alone.
    let only: Option<usize> = std::env::var("SYMTIME_ONLY").ok().and_then(|v| v.parse().ok());
    // SYMTIME_MAX_STEPS keeps the runs whose scripts are no longer than that.
    let longest: usize = std::env::var("SYMTIME_MAX_STEPS").ok().and_then(|v| v.parse().ok()).unwrap_or(usize::MAX);
    let kept: Vec<&Run> = runs.iter().enumerate().filter(|(i, _)| only.is_none_or(|o| o == *i)).map(|(_, r)| r).collect();
    let prepared: Vec<(linear::Script, Policy)> = kept
        .iter()
        .map(|r| (script_of(r, level), policy_for(r, &args.backend)))
        .filter(|(s, _)| s.steps.len() <= longest)
        .collect();
    // SIMPLEX_CAP=k concedes a run once its solver time passes k times the
    // run's own wall time (from --walls).
    let walls = walls_of(args);
    let cap: Option<f64> = std::env::var("SIMPLEX_CAP").ok().and_then(|v| v.parse().ok());
    let wall_us: Vec<f64> = kept.iter().map(|r| walls.get(&r.id).copied().unwrap_or(0.0)).collect();
    let backend = args.backend.as_str();
    let repeat: usize = std::env::var("SYMTIME_REPEAT").ok().and_then(|v| v.parse().ok()).unwrap_or(1).max(1);
    // One slot per script: a play takes it, unless it is to be played again.
    let slots: Vec<Mutex<Option<linear::Script>>> = prepared.iter().map(|(s, _)| Mutex::new(Some(s.clone()))).collect();
    let count = prepared.len();
    let next = AtomicUsize::new(0);
    let open = AtomicU64::new(0);
    let (conceded_runs, unanswered, asked, lost) = (AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0));
    let per_run = std::env::var_os("PER_RUN").is_some();
    let start = std::time::Instant::now();
    std::thread::scope(|scope| {
        for _ in 0..args.threads {
            scope.spawn(|| {
                let ctx = z3::Context::new(&z3::Config::new());
                let z3_solver = general::solver(&ctx, level, 10_000);
                #[cfg(feature = "with-yices")]
                let mut yices_solver = (backend == "yices").then(|| {
                    smt_yices::Yices::init();
                    smt_yices::Yices::new()
                });
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    if index >= count * repeat {
                        break;
                    }
                    let at = index % count;
                    let (_, policy) = &prepared[at];
                    let script = if repeat == 1 { slots[at].lock().unwrap().take().unwrap() } else { prepared[at].0.clone() };
                    let began = std::time::Instant::now();
                    let mut policy = *policy;
                    policy.deadline = cap.map(|k| began + std::time::Duration::from_nanos((k * wall_us[at] * 1000.0) as u64));
                    let outcome = match backend {
                        #[cfg(feature = "with-yices")]
                        "yices" => yices_solver.as_mut().unwrap().play(&script),
                        _ => play_by(backend, script, &policy, &ctx, &z3_solver),
                    };
                    let elapsed = began.elapsed();
                    if per_run {
                        eprintln!(
                            "RUN {index} ns {} wall {} us {} comparisons {} pivots {} rows {} widened {} conceded {} answers {}",
                            elapsed.as_nanos(),
                            wall_us[at],
                            elapsed.as_micros(),
                            outcome.open.len(),
                            outcome.report.pivots,
                            outcome.report.peak_rows,
                            outcome.report.widened,
                            outcome.unanswered(),
                            outcome.open.iter().fold(0xcbf29ce484222325u64, |h, o| (h ^ match o { None => 0u64, Some(false) => 1, Some(true) => 2 }).wrapping_mul(0x100000001b3))
                        );
                    }
                    open.fetch_add(outcome.open.iter().filter(|o| **o == Some(true)).count() as u64, Ordering::Relaxed);
                    conceded_runs.fetch_add(u64::from(outcome.conceded()), Ordering::Relaxed);
                    unanswered.fetch_add(outcome.unanswered() as u64, Ordering::Relaxed);
                    asked.fetch_add(outcome.open.len() as u64, Ordering::Relaxed);
                    lost.fetch_add(u64::from(outcome.report.continuation == Some(false)), Ordering::Relaxed);
                }
            });
        }
    });
    let seconds = start.elapsed().as_secs_f64();
    println!(
        "{backend:<13} threads {:>2}: {:>8.0} runs/s  (open outcomes {}, runs finished in concrete time {}, their comparisons left to it {} of {}, of which no point to go on from {})",
        args.threads,
        (count * repeat) as f64 / seconds,
        open.load(Ordering::Relaxed) / repeat as u64,
        conceded_runs.load(Ordering::Relaxed) / repeat as u64,
        unanswered.load(Ordering::Relaxed) / repeat as u64,
        asked.load(Ordering::Relaxed) / repeat as u64,
        lost.load(Ordering::Relaxed) / repeat as u64
    );
}

/// The runs the engine is slowest on, each timed in Z3 too against the
/// run's own wall time.
fn slowest(runs: &[Run], args: &Args) {
    let level = level_of(args);
    let walls = walls_of(args);
    let ctx = z3::Context::new(&z3::Config::new());
    let z3_solver = general::solver(&ctx, level, 60_000);
    let prepared: Vec<(linear::Script, Policy)> = runs.iter().map(|r| (script_of(r, level), policy_for(r, "simplex"))).collect();
    let mut timed: Vec<(u128, usize)> = Vec::new();
    for (i, (script, policy)) in prepared.iter().enumerate() {
        let copy = script.clone();
        let start = std::time::Instant::now();
        std::hint::black_box(drive::play(copy, policy));
        timed.push((start.elapsed().as_nanos(), i));
    }
    timed.sort_unstable_by(|a, b| b.cmp(a));
    let total: u128 = timed.iter().map(|t| t.0).sum();
    println!("engine total {:.2} s over {} runs; the slowest {} take {:.1}% of it", total as f64 / 1e9, runs.len(), args.emit_count, 100.0 * timed.iter().take(args.emit_count).map(|t| t.0).sum::<u128>() as f64 / total.max(1) as f64);
    println!("{:>7} {:>9} {:>6} {:>6} {:>7} {:>10} | {:>10} {:>10} {:>9}", "run", "unknowns", "rows", "cmps", "pivots", "merge work", "engine ms", "z3 ms", "run ms");
    for (ns, i) in timed.iter().take(args.emit_count) {
        let (script, policy) = &prepared[*i];
        let o = drive::play(script.clone(), policy);
        let t = std::time::Instant::now();
        std::hint::black_box(smt_z3::play(&ctx, &z3_solver, script));
        let z3_ms = t.elapsed().as_secs_f64() * 1e3;
        let wall = walls.get(&runs[*i].id).copied().unwrap_or(0.0) / 1e3;
        println!("{:>7} {:>9} {:>6} {:>6} {:>7} {:>10} | {:>10.1} {:>10.1} {:>9.2}", runs[*i].id, script.unknowns, o.report.peak_rows, o.open.len(), o.report.pivots, o.report.work, *ns as f64 / 1e6, z3_ms, wall);
    }
}

/// Whether fixing the scale is exact on these runs: the exact engine's
/// answers with each anchor against its answers with none, and how many rows
/// carry an absolute constant, which is what would make it inexact.
fn anchors_pass(runs: &[Run], args: &Args) {
    use linear::Anchor;
    let level = level_of(args);
    let rho = rho();
    let ctx = z3::Context::new(&z3::Config::new());
    let z3_solver = general::solver(&ctx, level, 10_000);
    let by_z3 = args.backend == "z3";
    let play = |script: linear::Script, run: &Run| if by_z3 { smt_z3::play(&ctx, &z3_solver, &script) } else { drive::play(script, &policy_for(run, "simplex")) };
    let mut constants = 0u64;
    let mut rows = 0u64;
    let mut with_constants = 0u64;
    let free: Vec<Outcome> = runs
        .iter()
        .map(|r| {
            let script = linear::script_anchored(r, level, &rho, Anchor::None);
            let mut any = false;
            for step in &script.steps {
                let mut count = |list: &[linear::Row]| {
                    for row in list {
                        rows += 1;
                        if row.constant != num_rational::Ratio::from_integer(0) && row.terms.len() > 1 {
                            constants += 1;
                            any = true;
                        }
                    }
                };
                match step {
                    linear::Step::Require(list) => count(list),
                    linear::Step::Decide { taken, .. } => count(taken),
                    _ => {}
                }
            }
            with_constants += u64::from(any);
            play(script, r)
        })
        .collect();
    println!("{} runs; rows over two or more unknowns with an absolute constant: {constants} of {rows}, in {with_constants} runs", runs.len());
    for anchor in [Anchor::Election, Anchor::Sum] {
        let (mut changed_runs, mut closed, mut opened, mut rejected) = (0u64, 0u64, 0u64, 0u64);
        for (run, base) in runs.iter().zip(&free) {
            let o = play(linear::script_anchored(run, level, &rho, anchor), run);
            rejected += u64::from(o.report.rejected > 0);
            if o.open != base.open {
                changed_runs += 1;
            }
            for (a, b) in o.open.iter().zip(&base.open) {
                closed += u64::from(*b == Some(true) && *a != Some(true));
                opened += u64::from(*b != Some(true) && *a == Some(true));
            }
        }
        println!("  anchor {anchor:?}: answers changed in {changed_runs} runs ({closed} outcomes closed, {opened} opened); the record rejected in {rejected} runs");
    }
}

/// Liveness by the record's drop signal against last mention: how long a
/// time unknown outlives its last mention, how many live at once, and how
/// many time events share a step's unknown.
fn liveness_pass(runs: &[Run], args: &Args) {
    let level = level_of(args);
    let (mut events, mut groups, mut died, mut lag, mut early) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let (mut peak_drop, mut peak_last) = (Vec::new(), Vec::new());
    let peak = |script: &linear::Script| {
        let times: std::collections::BTreeSet<usize> = script.times.iter().copied().collect();
        let (mut live, mut most) = (0i64, 0i64);
        for step in &script.steps {
            match step {
                linear::Step::Unknown(u, _) if times.contains(u) => live += 1,
                linear::Step::Dead(u) if times.contains(u) => live -= 1,
                _ => {}
            }
            most = most.max(live);
        }
        most as f64
    };
    for run in runs {
        events += run.time_events() as u64;
        groups += run.groups as u64;
        let dropped = script_of(run, level);
        died += dropped.liveness.died;
        lag += dropped.liveness.lag;
        early += dropped.liveness.early;
        peak_drop.push(peak(&dropped));
        std::env::set_var("LINEAR_LIVENESS", "last");
        peak_last.push(peak(&script_of(run, level)));
        std::env::remove_var("LINEAR_LIVENESS");
    }
    peak_drop.sort_by(f64::total_cmp);
    peak_last.sort_by(f64::total_cmp);
    println!("runs {}: time events {events} in {groups} step unknowns ({:.2} a step)", runs.len(), events as f64 / groups.max(1) as f64);
    println!("time unknowns released {died}; outlived their last mention by {:.2} script steps on average; released before a later mention {early}", lag as f64 / died.max(1) as f64);
    println!("peak live time unknowns: by release median {:.0} p99 {:.0} max {:.0}; by last mention median {:.0} p99 {:.0} max {:.0}",
        percentile(&peak_drop, 0.5), percentile(&peak_drop, 0.99), percentile(&peak_drop, 1.0),
        percentile(&peak_last, 0.5), percentile(&peak_last, 0.99), percentile(&peak_last, 1.0));
}

/// The runs in which the exact engine sees a check come back to a basis it
/// has been at, which is when the cycle guard takes over. The shortest
/// `--emit-count` of them are written to `SYMTIME_DUMP_DIR`, with Z3's
/// answers, as fixtures for the guard's tests.
fn cycling_pass(runs: &[Run], args: &Args) {
    let level = level_of(args);
    let ctx = z3::Context::new(&z3::Config::new());
    let z3_solver = general::solver(&ctx, level, 10_000);
    let mut found: Vec<(usize, usize, u64)> = Vec::new();
    for (index, run) in runs.iter().enumerate() {
        let script = script_of(run, level);
        let steps = script.steps.len();
        let outcome = drive::play(script, &policy_for(run, "simplex"));
        if outcome.report.cycling_checks > 0 {
            found.push((steps, index, outcome.report.cycling_checks));
        }
    }
    found.sort();
    println!("{} of {} runs had a check that cycled", found.len(), runs.len());
    for (steps, index, checks) in found.iter().take(20) {
        println!("  run {} (index {index}): {steps} steps, {checks} checks cycled", runs[*index].id);
    }
    let Some(dir) = std::env::var_os("SYMTIME_DUMP_DIR") else { return };
    std::fs::create_dir_all(&dir).unwrap();
    for (_, index, _) in found.iter().take(args.emit_count) {
        let run = &runs[*index];
        let script = script_of(run, level);
        let answers = smt_z3::play(&ctx, &z3_solver, &script).open;
        let path = std::path::Path::new(&dir).join(format!("run_{}.txt", run.id));
        std::fs::write(&path, dump::dump(&script, &answers)).unwrap();
        println!("wrote {}", path.display());
    }
}

fn main() {
    let args = args();
    if args.command == "agree" {
        let tally = agree::agree(&args.tc, args.limit);
        println!("{tally:?}");
        return;
    }
    let runs = load(&args);
    match args.command.as_str() {
        "check" => check(&runs),
        "classify" => classify(&runs),
        "general" => general_pass(&runs, &args),
        "threads" => threads_pass(&runs, &args),
        "linear" => linear_pass(&runs, &args),
        "linear-threads" => linear_threads(&runs, &args),
        "slowest" => slowest(&runs, &args),
        "anchors" => anchors_pass(&runs, &args),
        "cycling" => cycling_pass(&runs, &args),
        "liveness" => liveness_pass(&runs, &args),
        "witness" => witness_pass(&runs),
        "patterns" => patterns_pass(&runs),
        other => panic!("unknown command {other}"),
    }
}
