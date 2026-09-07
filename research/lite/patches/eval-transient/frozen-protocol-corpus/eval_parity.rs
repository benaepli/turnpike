use super::eval;
use super::values::{Env, Value, ValueMap, eval_accounting};
use crate::analysis::resolver::NameId;
use crate::compiler::cfg::{Expr, VarSlot};
use crate::simulator::core::state::NodeId;
use crate::simulator::hash_utils::{HashPolicy, NoHashing, WithHashing};
use std::cell::Cell;
use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};

thread_local! { static REFERENCE: Cell<bool> = const { Cell::new(false) }; }
pub(crate) fn use_reference() -> bool { REFERENCE.get() }
pub(crate) fn select(reference: bool) { REFERENCE.set(reference); }

fn binding(index: u32, node: bool) -> Expr {
    Expr::Var(if node { VarSlot::Node(index, NameId(0)) } else { VarSlot::Local(index, NameId(0)) })
}

fn environments<H: HashPolicy>() -> (Env<H>, Env<H>) {
    let mut map = ValueMap::new();
    map.insert(Value::int(1), Value::list(vec![Value::int(4), Value::option_none()].into()));
    let values = vec![
        Value::int(7), Value::bool(true), Value::string("hello".into()),
        Value::list(vec![Value::int(2), Value::list(vec![].into())].into()),
        Value::tuple(vec![Value::int(3), Value::map(map.clone())].into()),
        Value::map(map), Value::option_some(Value::list(vec![Value::int(9)].into())),
        Value::variant(3, "Payload".into(), Some(std::sync::Arc::new(Value::int(13)))),
        Value::node(NodeId { role: NameId(8), index: 2 }), Value::option_none(),
        Value::unit(), Value::list(vec![].into()),
    ];
    let mut local = Env::with_slots(values.len());
    let mut node = Env::with_slots(values.len());
    for (i, value) in values.into_iter().enumerate() {
        local.set(i as u32, value.clone());
        node.set(i as u32, value);
    }
    (local, node)
}

fn explicit_cases() -> Vec<Expr> {
    use Expr::*;
    let b = Box::new;
    let panic = || Div(b(Int(1)), b(Int(0)));
    let fail = || Unwrap(b(Nil));
    let mut cases = vec![
        Int(i64::MIN), Int(i64::MAX), Int(0), Bool(true), Bool(false), Unit, Nil,
        String("\u{e9}\n\"".into()), List(vec![]), Tuple(vec![]), Map(vec![]),
        List(vec![List(vec![]), Tuple(vec![]), Map(vec![])]),
        Plus(b(Int(i64::MAX)), b(Int(1))), Minus(b(Int(i64::MIN)), b(Int(1))),
        Times(b(Int(i64::MAX)), b(Int(2))), Div(b(Int(i64::MIN)), b(Int(-1))),
        Mod(b(Int(i64::MIN)), b(Int(-1))), panic(), Mod(b(Int(1)), b(Int(0))),
        Plus(b(String("a".into())), b(String("b".into()))),
        And(b(Bool(false)), b(panic())), Or(b(Bool(true)), b(panic())),
        Coalesce(b(Some(b(Int(2)))), b(panic())), Coalesce(b(Nil), b(Int(5))),
        SafeFind(b(Nil), b(panic())), SafeTupleAccess(b(Nil), usize::MAX),
        Variant(4, "Empty".into(), None), Variant(4, "Payload".into(), std::option::Option::Some(b(Int(3)))),
        VariantPayload(b(Variant(4, "Empty".into(), None))),
        SafeFind(b(Some(b(binding(5, false)))), b(Int(1))),
        SafeTupleAccess(b(Some(b(binding(4, true)))), 1),
        SafeFind(b(Some(b(Int(3)))), b(panic())),
        Find(b(Int(3)), b(panic())),
        ListSubsequence(b(Int(3)), b(panic()), b(Int(2))),
        Store(b(Int(3)), b(panic()), b(Int(2))),
    ];
    for node in [false, true] {
        for index in 0..12 { cases.push(binding(index, node)); }
        for index in [-1, 0, 1, 2, i64::MAX] {
            cases.push(Find(b(binding(3, node)), b(Int(index))));
            cases.push(Find(b(binding(5, node)), b(Int(index))));
            cases.push(ListSubsequence(b(binding(3, node)), b(Int(index)), b(Int(1))));
        }
    }
    type Binary = fn(Box<Expr>, Box<Expr>) -> Expr;
    let binary: &[Binary] = &[
        Plus, Minus, Times, Div, Mod, Min, LessThan, LessThanEquals, GreaterThan,
        GreaterThanEquals, EqualsEquals, And, Or, Find, KeyExists, MapErase,
        ListAppend, ListPrepend, Coalesce, SafeFind,
    ];
    let operands = vec![Int(1), Bool(true), String("x".into()), Nil, Unit,
        binding(3, false), binding(5, true), Some(b(Int(2)))];
    for &op in binary {
        for a in &operands {
            for c in &operands { cases.push(op(b(a.clone()), b(c.clone()))); }
            cases.push(op(b(a.clone()), b(panic())));
            cases.push(op(b(a.clone()), b(fail())));
        }
    }
    type Unary = fn(Box<Expr>) -> Expr;
    for op in [Not as Unary, Some, Unwrap, ListLen, IntToString, BoolToString, NodeToString, VariantPayload] {
        for a in &operands { cases.push(op(b(a.clone()))); }
        for index in 0..12 { cases.push(op(b(binding(index, false)))); }
    }
    for a in &operands {
        for index in [0, 1, usize::MAX] {
            cases.push(ListAccess(b(a.clone()), index));
            cases.push(TupleAccess(b(a.clone()), index));
            cases.push(SafeTupleAccess(b(a.clone()), index));
        }
        cases.push(IsVariant(b(a.clone()), "Payload".into()));
        cases.push(Store(b(a.clone()), b(Int(1)), b(Int(6))));
    }
    cases.push(Store(b(binding(3, false)), b(Int(0)), b(Int(6))));
    cases.push(Store(b(binding(5, true)), b(Int(1)), b(Int(6))));
    cases
}

struct Generator(u64);
impl Generator {
    fn draw(&mut self, n: u64) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 32) % n
    }
    fn scalar(&mut self, depth: usize) -> Expr {
        use Expr::*;
        if depth == 0 { return Int(self.draw(11) as i64 - 5); }
        let a = Box::new(self.scalar(depth - 1));
        let c = Box::new(self.scalar(depth - 1));
        match self.draw(5) { 0 => Plus(a,c), 1 => Minus(a,c), 2 => Times(a,c), 3 => Min(a,c), _ => Coalesce(Box::new(Nil), c) }
    }
    fn expression(&mut self, depth: usize) -> Expr {
        use Expr::*;
        if depth == 0 {
            return match self.draw(8) {
                0 => Int([i64::MIN, i64::MAX, -1, 0, 1, 2][self.draw(6) as usize]),
                1 => Bool(self.draw(2) == 0), 2 => String("str".into()), 3 => Nil,
                4 => Unit, 5 => List(vec![]), _ => binding(self.draw(12) as u32, self.draw(2) == 0),
            };
        }
        let op = self.draw(44);
        let a = Box::new(self.expression(depth - 1));
        let c = Box::new(self.expression(depth - 1));
        match op {
            0 => Find(a,c), 1 => Not(a), 2 => And(a,c), 3 => Or(a,c), 4 => EqualsEquals(a,c),
            5 => Map(vec![(*a,*c)]), 6 => List(vec![*a,*c]), 7 => ListPrepend(a,c),
            8 => ListAppend(a,c), 9 => ListSubsequence(a,c,Box::new(self.expression(depth-1))),
            10 => LessThan(a,c), 11 => LessThanEquals(a,c), 12 => GreaterThan(a,c),
            13 => GreaterThanEquals(a,c), 14 => KeyExists(a,c), 15 => MapErase(a,c),
            16 => Store(a,c,Box::new(self.expression(depth-1))), 17 => ListLen(a),
            18 => ListAccess(a,self.draw(4) as usize), 19 => Plus(a,c), 20 => Minus(a,c),
            21 => Times(a,c), 22 => Div(a,c), 23 => Mod(a,c), 24 => Min(a,c),
            25 => Tuple(vec![*a,*c]), 26 => TupleAccess(a,self.draw(4) as usize),
            27 => Unwrap(a), 28 => Coalesce(a,c), 29 => Some(a), 30 => IntToString(a),
            31 => BoolToString(a), 32 => NodeToString(a),
            33 => Variant(3,"Payload".into(),std::option::Option::Some(a)), 34 => IsVariant(a,"Payload".into()),
            35 => VariantPayload(a), 36 => SafeFind(a,c), 37 => SafeTupleAccess(a,self.draw(4) as usize),
            _ => self.expression(0),
        }
    }
}

fn expression_depth(expr: &Expr) -> usize {
    use Expr::*;
    match expr {
        Var(_) | Int(_) | Bool(_) | String(_) | Unit | Nil => 0,
        Not(a) | ListLen(a) | ListAccess(a,_) | TupleAccess(a,_) | Unwrap(a)
        | Some(a) | IntToString(a) | BoolToString(a) | NodeToString(a)
        | IsVariant(a,_) | VariantPayload(a) | SafeTupleAccess(a,_) => 1 + expression_depth(a),
        Find(a,b) | And(a,b) | Or(a,b) | EqualsEquals(a,b) | ListPrepend(a,b)
        | ListAppend(a,b) | LessThan(a,b) | LessThanEquals(a,b) | GreaterThan(a,b)
        | GreaterThanEquals(a,b) | KeyExists(a,b) | MapErase(a,b) | Plus(a,b)
        | Minus(a,b) | Times(a,b) | Div(a,b) | Mod(a,b) | Min(a,b) | Coalesce(a,b)
        | SafeFind(a,b) => 1 + expression_depth(a).max(expression_depth(b)),
        ListSubsequence(a,b,c) | Store(a,b,c) => 1 + expression_depth(a).max(expression_depth(b)).max(expression_depth(c)),
        List(items) | Tuple(items) => items.iter().map(expression_depth).max().map(|depth| 1 + depth).unwrap_or(0),
        Map(items) => items.iter().map(|(a,b)| expression_depth(a).max(expression_depth(b))).max().map(|depth| 1 + depth).unwrap_or(0),
        Variant(_,_,payload) => payload.as_ref().map(|p| 1 + expression_depth(p)).unwrap_or(0),
    }
}

fn outcome<H: HashPolicy>(reference: bool, local: &Env<H>, node: &Env<H>, expr: &Expr) -> (String, eval_accounting::Counts) {
    select(reference);
    eval_accounting::reset();
    let roles = HashMap::from([(NameId(8), "Node".to_owned())]);
    let result = catch_unwind(AssertUnwindSafe(|| eval::eval(local,node,expr,&roles)));
    let count = eval_accounting::snapshot();
    let text = match result {
        Ok(Ok(value)) => format!("ok:{:?}:{}", value.kind, value.sig),
        Ok(Err(error)) => format!("error:{error:?}"),
        Err(payload) => format!("panic:{}", payload.downcast_ref::<String>().map(String::as_str)
            .or_else(|| payload.downcast_ref::<&str>().copied()).unwrap_or("non-string")),
    };
    (text,count)
}

fn check_expressions<H: HashPolicy>() {
    let (local,node) = environments::<H>();
    let mut baseline = 0;
    let mut candidate = 0;
    let mut check = |expr: &Expr| {
        let (a,ac) = outcome(true,&local,&node,expr);
        let (b,bc) = outcome(false,&local,&node,expr);
        assert_eq!(a,b,"expression {expr:?}");
        baseline += ac.total(); candidate += bc.total();
    };
    for expr in explicit_cases() { check(&expr); }
    for seed in 1000..=1002 {
        let mut generator = Generator(seed);
        for i in 0..10000 {
            let expr = if i % 2 == 0 { generator.scalar(6) } else { generator.expression(6) };
            assert!(expression_depth(&expr) <= 6, "generator depth exceeds six");
            check(&expr);
        }
    }
    eprintln!("expression counts hashing={} reference={baseline} candidate={candidate}", H::EAGER);
    let profile = if cfg!(debug_assertions) { "debug" } else { "release" };
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tmp/loop/eval-parity/{profile}"));
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join(format!("expressions-hashing-{}.json",H::EAGER)),
        serde_json::to_vec_pretty(&serde_json::json!({"reference":baseline,"candidate":candidate,"generated_cases":30000,"explicit_cases":explicit_cases().len()})).unwrap()).unwrap();
    select(false);
}

#[test]
fn expression_corpus_no_hashing() { check_expressions::<NoHashing>(); }
#[test]
fn expression_corpus_with_hashing() { check_expressions::<WithHashing>(); }

#[test]
fn accounting_excludes_setup_and_counts_recursive_clones() {
    eval_accounting::reset();
    let value = Value::<WithHashing>::int(3);
    let _ = value.clone();
    assert_eq!(eval_accounting::snapshot().total(), 0);
    {
        let _scope = eval_accounting::Scope::enter();
        let _ = Value::<WithHashing>::with_sig(super::values::ValueKind::Int(2), 0);
        let _ = value.clone();
        let _ = Value::<WithHashing>::int(4);
    }
    assert_eq!(eval_accounting::snapshot(), eval_accounting::Counts { constructions: 2, clones: 1 });
    let _ = value.clone();
    assert_eq!(eval_accounting::snapshot().total(), 3);
}

#[test]
fn accounting_counts_collection_member_clones() {
    use super::values::ValueKind;
    let list = Value::<WithHashing>::list(vec![Value::int(1),Value::int(2),Value::int(3)].into());
    let tuple = Value::<WithHashing>::tuple(vec![Value::int(4),Value::int(5)].into());
    eval_accounting::reset();
    {
        let _scope = eval_accounting::Scope::enter();
        let mut copied_list = list.clone();
        if let ValueKind::List(items) = &mut copied_list.kind { items.make_mut(); }
        let mut copied_tuple = tuple.clone();
        if let ValueKind::Tuple(items) = &mut copied_tuple.kind { items.make_mut(); }
    }
    assert_eq!(eval_accounting::snapshot(),eval_accounting::Counts { constructions:0,clones:7 });
}
