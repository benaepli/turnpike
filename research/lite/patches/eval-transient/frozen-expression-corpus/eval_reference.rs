use crate::analysis::resolver::NameId;
use crate::compiler::cfg::{Expr, FunctionInfo, Lhs, VarSlot};
use crate::simulator::core::error::RuntimeError;
use crate::simulator::core::values::{
    Decimal, Env, Value, ValueKind, ValueMap, ValueSeq, hash_map_entry,
};
use crate::simulator::hash_utils::HashPolicy;
use ecow::EcoString;
use std::collections::HashMap;
use rustc_hash::FxHasher;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

#[inline(always)]
pub fn load<H: HashPolicy>(slot: VarSlot, local_env: &Env<H>, node_env: &Env<H>) -> Value<H> {
    match slot {
        VarSlot::Local(idx, _) => local_env.get(idx).clone(),
        VarSlot::Node(idx, _) => node_env.get(idx).clone(),
    }
}

#[inline(always)]
pub fn store_slot<H: HashPolicy>(
    slot: VarSlot,
    val: Value<H>,
    local_env: &mut Env<H>,
    node_env: &mut Env<H>,
) {
    match slot {
        VarSlot::Local(idx, _) => local_env.set(idx, val),
        VarSlot::Node(idx, _) => node_env.set(idx, val),
    }
}

pub fn store<H: HashPolicy>(
    lhs: &Lhs,
    val: Value<H>,
    local_env: &mut Env<H>,
    node_env: &mut Env<H>,
) -> Result<(), RuntimeError> {
    match lhs {
        Lhs::Var(slot) => {
            store_slot(*slot, val, local_env, node_env);
            Ok(())
        }
    }
}

/// Create a fresh local environment for calling a function
pub fn make_local_env<H: HashPolicy>(
    func: &FunctionInfo,
    args: Vec<Value<H>>,
    local_env: &Env<H>,
    node_env: &Env<H>,
    role_names: &HashMap<NameId, String>,
) -> Env<H> {
    let mut env = Env::<H>::with_slots(func.local_slot_count as usize);

    // Set arguments in parameter slots
    for (i, arg) in args.into_iter().enumerate() {
        env.set(i as u32, arg);
    }

    // Initialize other locals to their defaults
    for (i, default_expr) in func.local_defaults.iter().enumerate() {
        let slot = func.param_count + i as u32;
        if let Ok(val) = eval(local_env, node_env, default_expr, role_names) {
            env.set(slot, val);
        }
    }

    env
}

fn update_collection<H: HashPolicy>(
    col: Value<H>,
    key: Value<H>,
    val: Value<H>,
) -> Result<Value<H>, RuntimeError> {
    use ValueKind::*;
    match col.kind {
        Map(m) => {
            let new_sig = if H::EAGER {
                let mut s = col.sig;

                // Remove the old entry's contribution (if it exists)
                if let Some(old_val) = m.get(&key) {
                    let old_entry_hash = hash_map_entry(key.sig, old_val.sig);
                    s ^= old_entry_hash; // XOR removes it
                // length stays the same when replacing, so no change needed
                } else {
                    // Key doesn't exist, length will increase by 1
                    // Remove old length hash, add new length hash
                    let mut h = FxHasher::default();
                    9u8.hash(&mut h);
                    m.len().hash(&mut h);
                    s ^= h.finish();

                    let mut h = FxHasher::default();
                    9u8.hash(&mut h);
                    (m.len() + 1).hash(&mut h);
                    s ^= h.finish();
                }

                // Add the new entry's contribution
                let new_entry_hash = hash_map_entry(key.sig, val.sig);
                s ^= new_entry_hash;
                s
            } else {
                0
            };

            let new_map = m.update(key, val);

            Ok(Value::<H>::with_sig(ValueKind::Map(new_map), new_sig))
        }
        List(mut l) => {
            let idx = key.as_int()? as usize;
            if idx >= l.len() {
                return Err(RuntimeError::IndexOutOfBounds {
                    index: idx,
                    len: l.len(),
                });
            }
            l.make_mut()[idx] = val;
            Ok(Value::<H>::list(l))
        }
        _ => Err(RuntimeError::NotACollection {
            got: col.type_name(),
        }),
    }
}

pub fn eval<H: HashPolicy>(
    local_env: &Env<H>,
    node_env: &Env<H>,
    expr: &Expr,
    role_names: &HashMap<NameId, String>,
) -> Result<Value<H>, RuntimeError> {
    match expr {
        Expr::Int(i) => Ok(Value::<H>::int(*i)),
        Expr::Bool(b) => Ok(Value::<H>::bool(*b)),
        Expr::String(s) => Ok(Value::<H>::string(s.clone())),
        Expr::Unit => Ok(Value::<H>::unit()),
        Expr::Nil => Ok(Value::<H>::option_none()),
        Expr::Var(s) => Ok(load(*s, local_env, node_env)),
        Expr::Plus(e1, e2) => {
            let v1 = eval(local_env, node_env, e1, role_names)?;
            let v2 = eval(local_env, node_env, e2, role_names)?;

            match (&v1.kind, &v2.kind) {
                (ValueKind::Int(i1), ValueKind::Int(i2)) => Ok(Value::<H>::int(i1 + i2)),
                (ValueKind::String(s1), ValueKind::String(s2)) => {
                    let mut result = EcoString::with_capacity(s1.len() + s2.len());
                    result.push_str(s1.as_str());
                    result.push_str(s2.as_str());
                    Ok(Value::<H>::string(result))
                }
                _ => Err(RuntimeError::TypeError {
                    expected: "int or string",
                    got: v1.type_name(),
                }),
            }
        }
        Expr::Minus(e1, e2) => Ok(Value::<H>::int(
            eval(local_env, node_env, e1, role_names)?.as_int()?
                - eval(local_env, node_env, e2, role_names)?.as_int()?,
        )),
        Expr::Times(e1, e2) => Ok(Value::<H>::int(
            eval(local_env, node_env, e1, role_names)?.as_int()?
                * eval(local_env, node_env, e2, role_names)?.as_int()?,
        )),
        Expr::Div(e1, e2) => Ok(Value::<H>::int(
            eval(local_env, node_env, e1, role_names)?.as_int()?
                / eval(local_env, node_env, e2, role_names)?.as_int()?,
        )),
        Expr::Mod(e1, e2) => Ok(Value::<H>::int(
            eval(local_env, node_env, e1, role_names)?.as_int()?
                % eval(local_env, node_env, e2, role_names)?.as_int()?,
        )),
        Expr::LessThan(e1, e2) => Ok(Value::<H>::bool(
            eval(local_env, node_env, e1, role_names)? < eval(local_env, node_env, e2, role_names)?,
        )),
        Expr::EqualsEquals(e1, e2) => Ok(Value::<H>::bool(
            eval(local_env, node_env, e1, role_names)?
                == eval(local_env, node_env, e2, role_names)?,
        )),
        Expr::Not(e) => Ok(Value::<H>::bool(
            !eval(local_env, node_env, e, role_names)?.as_bool()?,
        )),
        Expr::And(e1, e2) => Ok(Value::<H>::bool(
            eval(local_env, node_env, e1, role_names)?.as_bool()?
                && eval(local_env, node_env, e2, role_names)?.as_bool()?,
        )),
        Expr::Or(e1, e2) => Ok(Value::<H>::bool(
            eval(local_env, node_env, e1, role_names)?.as_bool()?
                || eval(local_env, node_env, e2, role_names)?.as_bool()?,
        )),
        Expr::Some(e) => Ok(Value::<H>::option_some(eval(
            local_env, node_env, e, role_names,
        )?)),
        Expr::Tuple(es) => {
            let vals: Result<ValueSeq<H>, _> = es
                .iter()
                .map(|e| eval(local_env, node_env, e, role_names))
                .collect();
            Ok(Value::<H>::tuple(vals?))
        }
        Expr::List(es) => {
            let vals: Result<ValueSeq<H>, _> = es
                .iter()
                .map(|e| eval(local_env, node_env, e, role_names))
                .collect();
            Ok(Value::<H>::list(vals?))
        }
        Expr::Map(kv) => {
            let mut m = ValueMap::<H>::new();
            for (k, v) in kv {
                m.insert(
                    eval(local_env, node_env, k, role_names)?,
                    eval(local_env, node_env, v, role_names)?,
                );
            }
            Ok(Value::<H>::map(m))
        }
        Expr::Find(col, key) => {
            let col_val = eval(local_env, node_env, col, role_names)?;
            match &col_val.kind {
                ValueKind::Map(m) => {
                    let k = eval(local_env, node_env, key, role_names)?;
                    m.get(&k).cloned().ok_or(RuntimeError::KeyNotFound)
                }
                ValueKind::List(l) => {
                    let idx = eval(local_env, node_env, key, role_names)?.as_int()? as usize;
                    l.get(idx).cloned().ok_or(RuntimeError::IndexOutOfBounds {
                        index: idx,
                        len: l.len(),
                    })
                }
                _ => Err(RuntimeError::NotACollection {
                    got: col_val.type_name(),
                }),
            }
        }
        Expr::ListPrepend(head, tail) => {
            let h = eval(local_env, node_env, head, role_names)?;
            let tail_val = eval(local_env, node_env, tail, role_names)?;
            let t = tail_val.as_list()?;
            let mut new_list = ValueSeq::<H>::with_capacity(t.len() + 1);
            new_list.push(h);
            new_list.extend_from_slice(t);
            Ok(Value::<H>::list(new_list))
        }
        Expr::ListAppend(list, item) => {
            let list_val = eval(local_env, node_env, list, role_names)?;
            let mut l = list_val.as_list()?.clone();
            let i = eval(local_env, node_env, item, role_names)?;
            l.push(i);
            Ok(Value::<H>::list(l))
        }
        Expr::ListSubsequence(list, start, end) => {
            let l = eval(local_env, node_env, list, role_names)?;
            let s = eval(local_env, node_env, start, role_names)?.as_int()? as usize;
            let e = eval(local_env, node_env, end, role_names)?.as_int()? as usize;
            let vec = l.as_list()?;
            if s > vec.len() || e > vec.len() || s > e {
                return Err(RuntimeError::SubsequenceOutOfBounds {
                    start: s,
                    end: e,
                    len: vec.len(),
                });
            }
            Ok(Value::<H>::list(ValueSeq::<H>::from(&vec[s..e])))
        }
        Expr::LessThanEquals(e1, e2) => Ok(Value::<H>::bool(
            eval(local_env, node_env, e1, role_names)?
                <= eval(local_env, node_env, e2, role_names)?,
        )),
        Expr::GreaterThan(e1, e2) => Ok(Value::<H>::bool(
            eval(local_env, node_env, e1, role_names)? > eval(local_env, node_env, e2, role_names)?,
        )),
        Expr::GreaterThanEquals(e1, e2) => Ok(Value::<H>::bool(
            eval(local_env, node_env, e1, role_names)?
                >= eval(local_env, node_env, e2, role_names)?,
        )),
        Expr::KeyExists(key, map) => {
            let k = eval(local_env, node_env, key, role_names)?;
            let m = eval(local_env, node_env, map, role_names)?;
            Ok(Value::<H>::bool(m.as_map()?.contains_key(&k)))
        }
        Expr::MapErase(key, map) => {
            let k = eval(local_env, node_env, key, role_names)?;
            let m = eval(local_env, node_env, map, role_names)?
                .as_map()?
                .clone();
            Ok(Value::<H>::map(m.without(&k)))
        }
        Expr::ListLen(list) => {
            let list_val = eval(local_env, node_env, list, role_names)?;
            match &list_val.kind {
                ValueKind::List(l) => Ok(Value::<H>::int(l.len() as i64)),
                ValueKind::Map(m) => Ok(Value::<H>::int(m.len() as i64)),
                _ => Err(RuntimeError::NotACollection {
                    got: list_val.type_name(),
                }),
            }
        }
        Expr::ListAccess(list, idx) => {
            let l = eval(local_env, node_env, list, role_names)?;
            let vec = l.as_list()?;
            let i = *idx;
            if i >= vec.len() {
                return Err(RuntimeError::IndexOutOfBounds {
                    index: i,
                    len: vec.len(),
                });
            }
            Ok(vec[i].clone())
        }
        Expr::Min(e1, e2) => {
            let v1 = eval(local_env, node_env, e1, role_names)?.as_int()?;
            let v2 = eval(local_env, node_env, e2, role_names)?.as_int()?;
            Ok(Value::<H>::int(v1.min(v2)))
        }
        Expr::TupleAccess(tuple, idx) => {
            let t = eval(local_env, node_env, tuple, role_names)?;
            if let ValueKind::Tuple(vec) = &t.kind {
                if *idx >= vec.len() {
                    return Err(RuntimeError::IndexOutOfBounds {
                        index: *idx,
                        len: vec.len(),
                    });
                }
                Ok(vec[*idx].clone())
            } else {
                Err(RuntimeError::TypeError {
                    expected: "tuple",
                    got: t.type_name(),
                })
            }
        }
        Expr::Unwrap(e) => {
            let val = eval(local_env, node_env, e, role_names)?;
            match &val.kind {
                ValueKind::Option(Some(v)) => Ok(Arc::unwrap_or_clone(v.clone())),
                ValueKind::Option(None) => Err(RuntimeError::UnwrapNone),
                _ => Err(RuntimeError::TypeError {
                    expected: "option",
                    got: val.type_name(),
                }),
            }
        }
        Expr::Coalesce(opt, default) => {
            let val = eval(local_env, node_env, opt, role_names)?;
            match &val.kind {
                ValueKind::Option(Some(v)) => Ok(Arc::unwrap_or_clone(v.clone())),
                ValueKind::Option(None) => eval(local_env, node_env, default, role_names),
                _ => Err(RuntimeError::CoalesceNonOption {
                    got: val.type_name(),
                }),
            }
        }
        Expr::IntToString(e) => {
            let n = eval(local_env, node_env, e, role_names)?.as_int()?;
            Ok(Value::<H>::string(EcoString::from(Decimal::of_i64(n).as_str())))
        }
        Expr::BoolToString(e) => Ok(Value::<H>::string(EcoString::from(
            eval(local_env, node_env, e, role_names)?
                .as_bool()?
                .to_string(),
        ))),
        Expr::NodeToString(e) => {
            let node_id = eval(local_env, node_env, e, role_names)?.as_node()?;
            let role_name = role_names
                .get(&node_id.role)
                .map(|s| s.as_str())
                .unwrap_or("Unknown");
            Ok(Value::<H>::string(EcoString::from(format!(
                "{}[{}]",
                role_name, node_id.index
            ))))
        }
        Expr::Store(col, key, val) => update_collection(
            eval(local_env, node_env, col, role_names)?,
            eval(local_env, node_env, key, role_names)?,
            eval(local_env, node_env, val, role_names)?,
        ),
        Expr::Variant(enum_id, name, payload) => {
            let payload_val = payload
                .as_ref()
                .map(|p| eval(local_env, node_env, p, role_names))
                .transpose()?
                .map(Arc::new);
            Ok(Value::<H>::variant(*enum_id, name.clone(), payload_val))
        }
        Expr::IsVariant(expr, name) => {
            let val = eval(local_env, node_env, expr, role_names)?;
            match &val.kind {
                ValueKind::Variant(_, variant_name, _) => {
                    Ok(Value::<H>::bool(variant_name == name))
                }
                _ => Ok(Value::<H>::bool(false)),
            }
        }
        Expr::VariantPayload(expr) => {
            let val = eval(local_env, node_env, expr, role_names)?;
            match &val.kind {
                ValueKind::Variant(_, _, Some(payload)) => Ok((**payload).clone()),
                ValueKind::Variant(_, _, None) => Err(RuntimeError::VariantHasNoPayload),
                _ => Err(RuntimeError::TypeError {
                    expected: "variant",
                    got: val.type_name(),
                }),
            }
        }
        Expr::SafeFind(col, key) => {
            let col_val = eval(local_env, node_env, col, role_names)?;
            match &col_val.kind {
                ValueKind::Option(None) => Ok(Value::<H>::option_none()),
                ValueKind::Option(Some(inner)) => {
                    let inner_val = Arc::unwrap_or_clone(inner.clone());
                    let key_val = eval(local_env, node_env, key, role_names)?;
                    match &inner_val.kind {
                        ValueKind::Map(m) => {
                            let result = m.get(&key_val).cloned().ok_or(RuntimeError::KeyNotFound)?;
                            Ok(Value::<H>::option_some(result))
                        }
                        ValueKind::List(l) => {
                            let idx = key_val.as_int()? as usize;
                            let result = l.get(idx).cloned().ok_or(RuntimeError::IndexOutOfBounds {
                                index: idx,
                                len: l.len(),
                            })?;
                            Ok(Value::<H>::option_some(result))
                        }
                        _ => Err(RuntimeError::NotACollection {
                            got: inner_val.type_name(),
                        }),
                    }
                }
                _ => Err(RuntimeError::TypeError {
                    expected: "option",
                    got: col_val.type_name(),
                }),
            }
        }
        Expr::SafeTupleAccess(tuple, idx) => {
            let t = eval(local_env, node_env, tuple, role_names)?;
            match &t.kind {
                ValueKind::Option(None) => Ok(Value::<H>::option_none()),
                ValueKind::Option(Some(inner)) => {
                    let inner_val = Arc::unwrap_or_clone(inner.clone());
                    if let ValueKind::Tuple(vec) = &inner_val.kind {
                        if *idx >= vec.len() {
                            return Err(RuntimeError::IndexOutOfBounds {
                                index: *idx,
                                len: vec.len(),
                            });
                        }
                        Ok(Value::<H>::option_some(vec[*idx].clone()))
                    } else {
                        Err(RuntimeError::TypeError {
                            expected: "tuple",
                            got: inner_val.type_name(),
                        })
                    }
                }
                _ => Err(RuntimeError::TypeError {
                    expected: "option",
                    got: t.type_name(),
                }),
            }
        }
    }
}
