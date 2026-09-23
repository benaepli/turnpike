//! One run's record, the linear form of each constraint, and the exact
//! re-evaluation of a run under a given timeline.
//!
//! Time moves only at an advance, so every event between two advances shares
//! one time. A "segment" is that stretch; segment 0 is time zero.

use num_rational::Ratio;
use num_traits::{One, Zero};
use serde_json::Value as Json;
use std::collections::BTreeMap;

pub type Q = Ratio<i128>;

fn q(text: &str) -> Q {
    match text.split_once('/') {
        Some((n, d)) => Q::new(n.parse().unwrap(), d.parse().unwrap()),
        None => Q::from_integer(text.parse().unwrap()),
    }
}

fn int(json: &Json, key: &str) -> i128 {
    json[key].as_i64().map(i128::from).or_else(|| json[key].as_u64().map(i128::from)).unwrap_or_else(|| panic!("{key} in {json}"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Shape {
    Constant,
    TwoPoint,
    General,
    Unknown,
}

struct Clock {
    num: i128,
    den: i128,
    origin: i128,
}

impl Clock {
    fn reading(&self, time: i128) -> i128 {
        self.origin + (self.num * time).div_euclid(self.den)
    }
    fn rate(&self) -> Q {
        Q::new(self.num, self.den)
    }
}

struct Observation {
    node: usize,
    time: i128,
    earliest: i128,
    latest: i128,
    truetime: bool,
    segment: usize,
    event: usize,
}

#[derive(Clone, Copy, PartialEq)]
enum End {
    Mono,
    Earliest,
    Latest,
}

enum Source {
    Observed { observation: usize, end: End },
    Fixed,
    Duration(String),
    Unknown,
    Op { op: String, a: usize, b: Option<usize>, scalar: Option<i128> },
}

struct Value {
    source: Source,
    recorded: Q,
}

struct Timer {
    node: usize,
    after: bool,
    bound: Option<usize>,
    observation: Option<usize>,
    deadline: i128,
}

enum Step {
    Observation,
    Fire { timer: usize, event: usize, segment: usize },
    Compare { op: String, a: usize, b: usize, result: bool, site: usize },
    Advance,
}

/// A time event: an observation or a timed fire. Each has one unknown time.
struct Event {
    node: usize,
    truetime: bool,
}

/// `sum(c[e] * reading(e)) + k`, where `reading(e)` is the clock reading at
/// event `e`.
#[derive(Clone, Default)]
pub struct Linear {
    pub c: BTreeMap<usize, Q>,
    /// Coefficients on named durations, by field.
    pub d: BTreeMap<String, Q>,
    pub k: Q,
    tainted: bool,
}

impl Linear {
    fn constant(k: Q) -> Self {
        Self { c: BTreeMap::new(), d: BTreeMap::new(), k, tainted: false }
    }
    fn combine(&self, other: &Linear, sign: i128) -> Linear {
        let mut out = self.clone();
        let sign = Q::from_integer(sign);
        for (e, c) in &other.c {
            let entry = out.c.entry(*e).or_insert_with(Q::zero);
            *entry += c * sign;
        }
        out.c.retain(|_, c| !c.is_zero());
        for (f, c) in &other.d {
            let entry = out.d.entry(f.clone()).or_insert_with(Q::zero);
            *entry += c * sign;
        }
        out.d.retain(|_, c| !c.is_zero());
        out.k += other.k * sign;
        out.tainted |= other.tainted;
        out
    }
    fn scaled(&self, by: Q) -> Linear {
        let mut out = self.clone();
        for c in out.c.values_mut() {
            *c *= by;
        }
        out.c.retain(|_, c| !c.is_zero());
        for c in out.d.values_mut() {
            *c *= by;
        }
        out.d.retain(|_, c| !c.is_zero());
        out.k *= by;
        out
    }
}

/// `form >= 0`, or `form > 0` when strict.
#[derive(Clone)]
pub struct Requirement {
    pub form: Linear,
    pub strict: bool,
}

impl Requirement {
    fn negated(&self) -> Requirement {
        Requirement { form: self.form.scaled(-Q::one()), strict: !self.strict }
    }
}

pub struct Constraint {
    /// All hold.
    pub taken: Vec<Requirement>,
    /// The other outcome: any one of these conjunctions.
    pub other: Vec<Vec<Requirement>>,
    pub site: Option<usize>,
    pub outcome: bool,
}

impl Constraint {
    pub fn what(&self) -> &'static str {
        if self.site.is_some() { "comparison" } else { "timer" }
    }
    pub fn site(&self) -> Option<usize> {
        self.site
    }
    pub fn shape(&self, run: &Run) -> Shape {
        self.taken
            .iter()
            .map(|r| run.classify(r))
            .max()
            .unwrap_or(Shape::Constant)
    }
}

pub struct Run {
    pub id: i64,
    pub unknown: u64,
    clocks: Vec<Clock>,
    observations: Vec<Observation>,
    values: Vec<Value>,
    timers: BTreeMap<usize, Timer>,
    steps: Vec<Step>,
    events: Vec<Event>,
    segments: usize,
    advances: Vec<i128>,
    pub durations: BTreeMap<String, Q>,
}

#[derive(Default)]
pub struct Report {
    pub values: u64,
    pub comparisons: u64,
    pub deadlines: u64,
    pub value_mismatches: u64,
    pub flipped: u64,
    pub deadline_mismatches: u64,
    pub ineligible: u64,
}

fn ceil(value: &Q) -> i128 {
    value.ceil().to_integer()
}

impl Run {
    pub fn parse(json: &Json) -> Run {
        let clocks: Vec<Clock> = json["clocks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                let c = c.as_array().unwrap();
                Clock {
                    num: c[0].as_i64().unwrap() as i128,
                    den: c[1].as_i64().unwrap() as i128,
                    origin: c[2].as_i64().unwrap() as i128,
                }
            })
            .collect();
        let mut run = Run {
            id: json["run"].as_i64().unwrap(),
            unknown: json["unknown"].as_u64().unwrap(),
            clocks,
            observations: Vec::new(),
            values: Vec::new(),
            timers: BTreeMap::new(),
            steps: Vec::new(),
            events: Vec::new(),
            segments: 0,
            advances: Vec::new(),
            durations: BTreeMap::new(),
        };
        let mut pending: Option<Timer> = None;
        for e in json["events"].as_array().unwrap() {
            match e["e"].as_str().unwrap() {
                "adv" => {
                    run.segments += 1;
                    run.advances.push(int(e, "ticks"));
                    run.steps.push(Step::Advance);
                }
                "obs" => {
                    let node = int(e, "node") as usize;
                    let truetime = e["truetime"].as_bool().unwrap();
                    run.events.push(Event { node, truetime });
                    run.observations.push(Observation {
                        node,
                        time: int(e, "time"),
                        earliest: int(e, "earliest"),
                        latest: int(e, "latest"),
                        truetime,
                        segment: run.segments,
                        event: run.events.len() - 1,
                    });
                    run.steps.push(Step::Observation);
                }
                "leaf" => {
                    let recorded = q(e["value"].as_str().unwrap());
                    let source = match e["src"].as_str().unwrap() {
                        "obs" => Source::Observed {
                            observation: int(e, "obs") as usize,
                            end: match e["end"].as_str().unwrap() {
                                "mono" => End::Mono,
                                "earliest" => End::Earliest,
                                _ => End::Latest,
                            },
                        },
                        "duration" => {
                            let field = e["field"].as_str().unwrap().to_string();
                            run.durations.insert(field.clone(), recorded);
                            Source::Duration(field)
                        }
                        _ if e["kind"] == "Duration" && recorded.is_zero() => Source::Fixed,
                        _ => Source::Unknown,
                    };
                    assert_eq!(int(e, "id") as usize, run.values.len());
                    run.values.push(Value { source, recorded });
                }
                "op" => {
                    assert_eq!(int(e, "id") as usize, run.values.len());
                    run.values.push(Value {
                        source: Source::Op {
                            op: e["op"].as_str().unwrap().to_string(),
                            a: int(e, "a") as usize,
                            b: e["b"].as_u64().map(|b| b as usize),
                            scalar: e["int"].as_i64().map(i128::from),
                        },
                        recorded: q(e["value"].as_str().unwrap()),
                    });
                }
                "cmp" => run.steps.push(Step::Compare {
                    op: e["op"].as_str().unwrap().to_string(),
                    a: int(e, "a") as usize,
                    b: int(e, "b") as usize,
                    result: e["result"].as_bool().unwrap(),
                    site: int(e, "site") as usize,
                }),
                "reg" => {
                    pending = Some(Timer {
                        node: int(e, "node") as usize,
                        after: e["after"].as_bool().unwrap(),
                        bound: e["bound"].as_u64().map(|b| b as usize),
                        observation: e["obs"].as_u64().map(|o| o as usize),
                        deadline: int(e, "deadline"),
                    });
                }
                "timer" => {
                    if e["deadline"].is_null() {
                        continue;
                    }
                    let id = int(e, "timer") as usize;
                    match e["what"].as_str().unwrap() {
                        "registered" => {
                            let timer = pending.take().expect("a registration before its timer");
                            assert_eq!(timer.deadline, int(e, "deadline"));
                            run.timers.insert(id, timer);
                        }
                        "fired" => {
                            let node = int(e, "node") as usize;
                            run.events.push(Event { node, truetime: false });
                            run.steps.push(Step::Fire { timer: id, event: run.events.len() - 1, segment: run.segments });
                        }
                        _ => {}
                    }
                }
                other => panic!("unknown event {other}"),
            }
        }
        run
    }

    /// Each step that creates an unknown or adds a constraint, in order.
    pub fn stages(&self) -> Vec<(bool, Option<Constraint>)> {
        self.ordered()
            .into_iter()
            .map(|(step, c)| (matches!(step, Step::Observation | Step::Fire { .. }), c))
            .collect()
    }

    /// The node an event's clock belongs to, or `None` for a truetime read.
    pub fn clock_of(&self, event: usize) -> Option<usize> {
        let e = &self.events[event];
        (!e.truetime).then_some(e.node)
    }

    pub fn rate_of(&self, node: usize) -> Q {
        self.clocks[node].rate()
    }

    /// The rates of the first `n` nodes, as text.
    /// The recorded time of each segment.
    pub fn segment_times(&self) -> Vec<i128> {
        let mut times = vec![0i128];
        for ticks in &self.advances {
            times.push(times.last().unwrap() + ticks);
        }
        times
    }

    fn reading(&self, observation: &Observation, end: End, times: &[i128]) -> i128 {
        let time = times[observation.segment];
        if observation.truetime {
            let recorded = if end == End::Earliest { observation.earliest } else { observation.latest };
            return recorded + (time - observation.time);
        }
        self.clocks[observation.node].reading(time)
    }

    fn values_under(&self, times: &[i128]) -> Vec<Q> {
        let mut out: Vec<Q> = Vec::with_capacity(self.values.len());
        for value in &self.values {
            let v = match &value.source {
                Source::Observed { observation, end } => {
                    Q::from_integer(self.reading(&self.observations[*observation], *end, times))
                }
                Source::Fixed | Source::Duration(_) | Source::Unknown => value.recorded,
                Source::Op { op, a, b, scalar } => {
                    let left = out[*a];
                    match op.as_str() {
                        "Add" => left + out[b.unwrap()],
                        "Subtract" | "Difference" => left - out[b.unwrap()],
                        "Scale" => left * Q::from_integer(scalar.unwrap()),
                        "Divide" => left / Q::from_integer(scalar.unwrap()),
                        "Min" => left.min(out[b.unwrap()]),
                        other => panic!("unknown op {other}"),
                    }
                }
            };
            out.push(v);
        }
        out
    }

    fn deadline_under(&self, timer: &Timer, values: &[Q], times: &[i128]) -> i128 {
        let bound = ceil(&values[timer.bound.expect("a timed registration has a bound")]);
        if timer.after {
            let observation = &self.observations[timer.observation.unwrap()];
            self.reading(observation, End::Mono, times) + bound
        } else {
            bound
        }
    }

    /// Re-evaluates the run with floor readings and ceiling deadlines at
    /// `times`, and compares everything against the record.
    pub fn evaluate(&self, times: &[i128]) -> Report {
        let mut report = self.evaluate_outcomes(times);
        let values = self.values_under(times);
        for (value, now) in self.values.iter().zip(&values) {
            report.values += 1;
            if value.recorded != *now {
                report.value_mismatches += 1;
            }
        }
        for timer in self.timers.values() {
            report.deadlines += 1;
            if self.deadline_under(timer, &values, times) != timer.deadline {
                report.deadline_mismatches += 1;
            }
        }
        report
    }

    /// Only what a changed timeline must preserve: every comparison's
    /// outcome, and every fire at or after its deadline.
    pub fn evaluate_outcomes(&self, times: &[i128]) -> Report {
        let mut report = Report::default();
        let values = self.values_under(times);
        for step in &self.steps {
            match step {
                Step::Compare { op, a, b, result, .. } => {
                    report.comparisons += 1;
                    let (a, b) = (values[*a], values[*b]);
                    let now = match op.as_str() {
                        "Equal" => a == b,
                        "NotEqual" => a != b,
                        "Less" => a < b,
                        "LessEqual" => a <= b,
                        "Greater" => a > b,
                        "GreaterEqual" => a >= b,
                        other => panic!("unknown comparison {other}"),
                    };
                    if now != *result {
                        report.flipped += 1;
                    }
                }
                Step::Fire { timer, segment, .. } => {
                    let Some(timer) = self.timers.get(timer) else { continue };
                    let deadline = self.deadline_under(timer, &values, times);
                    if self.clocks[timer.node].reading(times[*segment]) < deadline {
                        report.ineligible += 1;
                    }
                }
                _ => {}
            }
        }
        report
    }

    fn rate(&self, event: usize) -> Q {
        let event = &self.events[event];
        if event.truetime { Q::one() } else { self.clocks[event.node].rate() }
    }

    fn offset(&self, observation: &Observation, end: End) -> Q {
        if observation.truetime {
            let recorded = if end == End::Earliest { observation.earliest } else { observation.latest };
            Q::from_integer(recorded - observation.time)
        } else {
            Q::from_integer(self.clocks[observation.node].origin)
        }
    }

    fn linears(&self) -> Vec<Linear> {
        let mut out: Vec<Linear> = Vec::with_capacity(self.values.len());
        for value in &self.values {
            let l = match &value.source {
                Source::Observed { observation, end } => {
                    let o = &self.observations[*observation];
                    let mut l = Linear::constant(self.offset(o, *end));
                    l.c.insert(o.event, Q::one());
                    l
                }
                Source::Fixed => Linear::constant(value.recorded),
                Source::Duration(field) => {
                    let mut l = Linear::constant(Q::zero());
                    l.d.insert(field.clone(), Q::one());
                    l
                }
                Source::Unknown => Linear { tainted: true, ..Linear::constant(value.recorded) },
                Source::Op { op, a, b, scalar } => {
                    let left = &out[*a];
                    match op.as_str() {
                        "Add" => left.combine(&out[b.unwrap()], 1),
                        "Subtract" | "Difference" => left.combine(&out[b.unwrap()], -1),
                        "Scale" => left.scaled(Q::from_integer(scalar.unwrap())),
                        "Divide" => left.scaled(Q::one() / Q::from_integer(scalar.unwrap())),
                        // The smaller operand of the record stands for the result.
                        "Min" => {
                            let b = b.unwrap();
                            if self.values[b].recorded < self.values[*a].recorded { out[b].clone() } else { left.clone() }
                        }
                        other => panic!("unknown op {other}"),
                    }
                }
            };
            out.push(l);
        }
        out
    }

    /// Every constraint of the run, in the order the run met them.
    pub fn constraints(&self) -> Vec<Constraint> {
        self.ordered().into_iter().filter_map(|(_, c)| c).collect()
    }

    /// Each step paired with the constraint it adds, if any.
    fn ordered(&self) -> Vec<(&Step, Option<Constraint>)> {
        let linears = self.linears();
        let mut out = Vec::new();
        for step in &self.steps {
            let constraint = match step {
                Step::Fire { timer, event, .. } => self.timers.get(timer).map(|timer| {
                    // reading(fire) - deadline >= 0
                    let mut fire = Linear::constant(Q::from_integer(self.clocks[timer.node].origin));
                    fire.c.insert(*event, Q::one());
                    let bound = &linears[timer.bound.unwrap()];
                    let mut form = fire.combine(bound, -1);
                    if timer.after {
                        let o = &self.observations[timer.observation.unwrap()];
                        let mut at = Linear::constant(self.offset(o, End::Mono));
                        at.c.insert(o.event, Q::one());
                        form = form.combine(&at, -1);
                    }
                    Constraint { taken: vec![Requirement { form, strict: false }], other: Vec::new(), site: None, outcome: true }
                }),
                Step::Compare { op, a, b, result, site } => {
                    let (la, lb) = (&linears[*a], &linears[*b]);
                    let a_minus_b = la.combine(lb, -1);
                    let b_minus_a = lb.combine(la, -1);
                    let ge = Requirement { form: a_minus_b.clone(), strict: false };
                    let gt = Requirement { form: a_minus_b, strict: true };
                    let le = Requirement { form: b_minus_a.clone(), strict: false };
                    let lt = Requirement { form: b_minus_a, strict: true };
                    let equal = vec![ge.clone(), le.clone()];
                    let apart = vec![vec![gt.clone()], vec![lt.clone()]];
                    let above = self.values[*a].recorded > self.values[*b].recorded;
                    let (taken, other) = match (op.as_str(), *result) {
                        ("Less", true) | ("GreaterEqual", false) => (vec![lt.clone()], vec![vec![lt.negated()]]),
                        ("Less", false) | ("GreaterEqual", true) => (vec![ge.clone()], vec![vec![ge.negated()]]),
                        ("LessEqual", true) | ("Greater", false) => (vec![le.clone()], vec![vec![le.negated()]]),
                        ("LessEqual", false) | ("Greater", true) => (vec![gt.clone()], vec![vec![gt.negated()]]),
                        ("Equal", true) | ("NotEqual", false) => (equal, apart),
                        ("Equal", false) | ("NotEqual", true) => (vec![if above { gt } else { lt }], vec![equal]),
                        (other, _) => panic!("unknown comparison {other}"),
                    };
                    Some(Constraint { taken, other, site: Some(*site), outcome: *result })
                }
                _ => None,
            };
            out.push((step, constraint));
        }
        out
    }

    /// The linear form of `requirement` over real event times: a constant,
    /// a difference of two times, or more.
    pub fn classify(&self, requirement: &Requirement) -> Shape {
        let form = &requirement.form;
        if form.tainted {
            return Shape::Unknown;
        }
        let mut a: BTreeMap<usize, Q> = BTreeMap::new();
        for (event, c) in &form.c {
            *a.entry(event + 1).or_insert_with(Q::zero) += c * self.rate(*event);
        }
        a.retain(|_, v| !v.is_zero());
        let mut unknowns = a.values();
        match (unknowns.next(), unknowns.next(), unknowns.next()) {
            (None, ..) => Shape::Constant,
            (Some(_), None, _) => Shape::TwoPoint,
            (Some(au), Some(av), None) if (au + av).is_zero() => Shape::TwoPoint,
            _ => Shape::General,
        }
    }
}
