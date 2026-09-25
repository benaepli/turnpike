//! One run's record, the linear form of each constraint, and the exact
//! re-evaluation of a run under a given timeline.
//!
//! Time moves only at an advance, so every event between two advances shares
//! one time. A "segment" is that stretch; segment 0 is time zero.
//!
//! A scheduler step that does anything with time is marked in the record,
//! and every reading and fire in one step shares one time unknown: the
//! step's "group". The record also says when the run stopped holding each
//! time value, which is what an online engine can know of liveness.

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
    /// A value made, by id, and values the run stopped holding.
    Made(usize),
    Drop(Vec<usize>),
    /// A timed timer registered, and one that ended without firing.
    Registered(usize),
    Cancelled(usize),
}

/// A time event: an observation or a timed fire, in the group of its step.
struct Event {
    node: usize,
    truetime: bool,
    group: usize,
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
    /// Values of unknown origin. A zero duration is the language's one
    /// duration literal and is a constant, not unknown.
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
    /// How many groups the run's time events fall into.
    pub groups: usize,
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
            unknown: 0,
            clocks,
            observations: Vec::new(),
            values: Vec::new(),
            timers: BTreeMap::new(),
            steps: Vec::new(),
            events: Vec::new(),
            segments: 0,
            advances: Vec::new(),
            durations: BTreeMap::new(),
            groups: 0,
        };
        let mut pending: Option<Timer> = None;
        // Whether the next time event opens a group of its own.
        let mut opens = true;
        let mut stepped = false;
        let group = |run: &mut Run, opens: &mut bool| {
            if *opens {
                run.groups += 1;
                *opens = false;
            }
            run.groups - 1
        };
        for e in json["events"].as_array().unwrap() {
            match e["e"].as_str().unwrap() {
                "step" => {
                    opens = true;
                    stepped = true;
                }
                "drop" => {
                    let ids = e["ids"].as_array().unwrap().iter().map(|i| i.as_u64().unwrap() as usize).collect();
                    run.steps.push(Step::Drop(ids));
                }
                "adv" => {
                    run.segments += 1;
                    run.advances.push(int(e, "ticks"));
                    run.steps.push(Step::Advance);
                }
                "obs" => {
                    let node = int(e, "node") as usize;
                    let truetime = e["truetime"].as_bool().unwrap();
                    assert!(stepped, "a record without step markers");
                    let group = group(&mut run, &mut opens);
                    run.events.push(Event { node, truetime, group });
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
                        _ => {
                            run.unknown += 1;
                            Source::Unknown
                        }
                    };
                    assert_eq!(int(e, "id") as usize, run.values.len());
                    run.steps.push(Step::Made(run.values.len()));
                    run.values.push(Value { source, recorded });
                }
                "op" => {
                    assert_eq!(int(e, "id") as usize, run.values.len());
                    run.steps.push(Step::Made(run.values.len()));
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
                            run.steps.push(Step::Registered(id));
                        }
                        "fired" => {
                            let node = int(e, "node") as usize;
                            assert!(stepped, "a record without step markers");
                            let group = group(&mut run, &mut opens);
                            run.events.push(Event { node, truetime: false, group });
                            run.steps.push(Step::Fire { timer: id, event: run.events.len() - 1, segment: run.segments });
                        }
                        "cancelled" => run.steps.push(Step::Cancelled(id)),
                        _ => {}
                    }
                }
                other => panic!("unknown event {other}"),
            }
        }
        run
    }

    /// Each record step in order: the group it opens, if it is the group's
    /// first time event, and the constraint it adds, if any.
    pub fn stages(&self) -> Vec<(Option<usize>, Option<Constraint>)> {
        let mut seen = 0usize;
        let mut event = 0usize;
        self.ordered()
            .into_iter()
            .map(|(step, c)| {
                let mut opened = None;
                if matches!(step, Step::Observation | Step::Fire { .. }) {
                    let g = self.events[event].group;
                    event += 1;
                    if g == seen {
                        seen += 1;
                        opened = Some(g);
                    }
                }
                (opened, c)
            })
            .collect()
    }

    /// Readings and timed fires.
    pub fn time_events(&self) -> usize {
        self.events.len()
    }

    /// Whether the record says when the run stopped holding values.
    pub fn has_drops(&self) -> bool {
        self.steps.iter().any(|s| matches!(s, Step::Drop(_)))
    }

    /// The group of time event `event`.
    pub fn group_of(&self, event: usize) -> usize {
        self.events[event].group
    }

    /// For each stage, the groups that die after it by what the record says
    /// the run still holds: a group lives while a value the run holds or a
    /// pending timer's deadline mentions it, and while it is the newest.
    pub fn drop_deaths(&self) -> Vec<Vec<usize>> {
        let linears = self.linears();
        let groups_of = |l: &Linear| -> Vec<usize> {
            let mut g: Vec<usize> = l.c.keys().map(|e| self.events[*e].group).collect();
            g.sort_unstable();
            g.dedup();
            g
        };
        // How many holders each group has: live values and pending timers.
        let mut holders = vec![0u32; self.groups];
        let mut value_groups: Vec<Vec<usize>> = Vec::with_capacity(self.values.len());
        let mut timer_groups: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
        let mut newest: Option<usize> = None;
        let mut dead = vec![false; self.groups];
        let mut out = Vec::with_capacity(self.steps.len());
        let mut event = 0usize;
        for step in &self.steps {
            let mut released: Vec<usize> = Vec::new();
            match step {
                Step::Made(id) => {
                    debug_assert_eq!(*id, value_groups.len());
                    let g = groups_of(&linears[*id]);
                    for x in &g {
                        holders[*x] += 1;
                    }
                    value_groups.push(g);
                }
                Step::Observation | Step::Fire { .. } => {
                    let g = self.events[event].group;
                    event += 1;
                    if newest != Some(g) {
                        if let Some(n) = newest {
                            released.push(n);
                        }
                        newest = Some(g);
                    }
                }
                Step::Registered(t) => {
                    let timer = &self.timers[t];
                    let mut g = timer.bound.map_or(Vec::new(), |b| groups_of(&linears[b]));
                    if let Some(o) = timer.observation {
                        g.push(self.events[self.observations[o].event].group);
                    }
                    g.sort_unstable();
                    g.dedup();
                    for x in &g {
                        holders[*x] += 1;
                    }
                    timer_groups.insert(*t, g);
                }
                Step::Cancelled(t) => {
                    if let Some(g) = timer_groups.remove(t) {
                        for x in g {
                            holders[x] -= 1;
                            released.push(x);
                        }
                    }
                }
                Step::Drop(ids) => {
                    for id in ids {
                        if *id < value_groups.len() {
                            for x in std::mem::take(&mut value_groups[*id]) {
                                holders[x] -= 1;
                                released.push(x);
                            }
                        }
                    }
                }
                _ => {}
            }
            if let Step::Fire { timer, .. } = step {
                if let Some(g) = timer_groups.remove(timer) {
                    for x in g {
                        holders[x] -= 1;
                        released.push(x);
                    }
                }
            }
            released.sort_unstable();
            released.dedup();
            let mut dying = Vec::new();
            for g in released {
                if holders[g] == 0 && newest != Some(g) && !dead[g] {
                    dead[g] = true;
                    dying.push(g);
                }
            }
            out.push(dying);
        }
        out
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

    /// The newest reading a value was made from, if any.
    fn newest_observation(&self, value: usize) -> Option<usize> {
        match &self.values[value].source {
            Source::Observed { observation, .. } => Some(*observation),
            Source::Op { a, b, .. } => {
                let left = self.newest_observation(*a);
                let right = b.and_then(|b| self.newest_observation(b));
                left.max(right)
            }
            _ => None,
        }
    }

    /// Each comparison as the node whose newest reading it compares, its
    /// site, its operation and its result.
    pub fn comparisons(&self) -> Vec<(Option<usize>, usize, String, bool)> {
        self.steps
            .iter()
            .filter_map(|step| match step {
                Step::Compare { op, a, b, result, site } => {
                    let o = self.newest_observation(*a).max(self.newest_observation(*b));
                    Some((o.map(|o| self.observations[o].node), *site, op.clone(), *result))
                }
                _ => None,
            })
            .collect()
    }

    /// The rows a new timeline of this run has to meet, over one time per
    /// segment: the segments in order at least a tick apart, every
    /// comparison's recorded outcome, and every fire at or after its
    /// deadline. Why not, for a run it cannot say that for.
    pub fn witness_rows(&self) -> Result<(usize, Vec<spur_time::witness::Accepted>), &'static str> {
        use spur_time::witness::{Accepted, Term};
        let mut segment_of = vec![0usize; self.events.len()];
        for o in &self.observations {
            segment_of[o.event] = o.segment;
        }
        let linears = self.linears();
        let mut fires: BTreeMap<usize, bool> = BTreeMap::new();
        for step in &self.steps {
            if let Step::Fire { event, segment, timer } = step {
                segment_of[*event] = *segment;
                let whole = self.timers.get(timer).and_then(|t| t.bound).is_none_or(|b| {
                    let form = &linears[b];
                    form.k.is_integer() && form.c.values().all(|c| c.is_integer()) && form.d.values().all(|c| c.is_integer())
                });
                fires.insert(*event, whole);
            }
        }
        let unknowns = self.segments + 1;
        let one = Q::one();
        let mut rows = vec![Accepted { terms: vec![(0, one, Term::Raw)], constant: Q::zero(), strict: false, extra: Q::zero() }];
        for s in 1..unknowns {
            rows.push(Accepted { terms: vec![(s - 1, -one, Term::Raw), (s, one, Term::Raw)], constant: -one, strict: false, extra: Q::zero() });
        }
        let mut required: Vec<(Requirement, Q)> = Vec::new();
        for (step, constraint) in self.ordered() {
            let Some(constraint) = constraint else { continue };
            // A deadline is rounded up before it is used, which can take up
            // to a tick from the fire's row.
            let extra = match step {
                Step::Fire { event, .. } if !fires[event] => one,
                _ => Q::zero(),
            };
            required.extend(constraint.taken.into_iter().map(|r| (r, extra)));
        }
        // `min` keeps the operand it chose: the right one only when it is
        // strictly smaller.
        for value in &self.values {
            if let Source::Op { op, a, b: Some(b), .. } = &value.source {
                if op == "Min" {
                    let right = self.values[*b].recorded < self.values[*a].recorded;
                    let (form, strict) = if right { (linears[*a].combine(&linears[*b], -1), true) } else { (linears[*b].combine(&linears[*a], -1), false) };
                    required.push((Requirement { form, strict }, Q::zero()));
                }
            }
        }
        for (requirement, extra) in &required {
            let extra = *extra;
            {
                let form = &requirement.form;
                if form.tainted {
                    return Err("unknown_origin");
                }
                let mut constant = form.k;
                for (field, c) in &form.d {
                    constant += c * self.durations.get(field).ok_or("unassigned_duration")?;
                }
                // Readings of different clocks in one segment floor apart,
                // so each clock keeps a term of its own.
                let mut terms: BTreeMap<(usize, Option<Q>), Q> = BTreeMap::new();
                for (event, c) in &form.c {
                    let rate = self.rate(*event);
                    let floored = (!self.events[*event].truetime).then_some(rate);
                    *terms.entry((segment_of[*event], floored)).or_insert_with(Q::zero) += c * rate;
                }
                let terms = terms
                    .into_iter()
                    .filter(|(_, c)| !c.is_zero())
                    .map(|((s, f), c)| (s, c, f.map_or(Term::Raw, Term::Floored)))
                    .collect();
                rows.push(Accepted { terms, constant, strict: requirement.strict, extra });
            }
        }
        Ok((unknowns, rows))
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
