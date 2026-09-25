//! The linear script through Yices 2 in push-pop QF_LRA, by its C interface.
//!
//! `init` and `exit` run once per process. Without a thread-safe build the
//! library must stay on one thread. Unknowns are created once and reused
//! across runs so the global term table stays small.

use crate::linear::{Row, Script, Step};
use crate::drive::Outcome;
use std::ffi::CString;
use yices2_sys as y;

pub struct Yices {
    ctx: *mut y::context_t,
    unknowns: Vec<y::term_t>,
}

fn constant(q: &num_rational::Ratio<i128>) -> y::term_t {
    let text = CString::new(format!("{}/{}", q.numer(), q.denom())).unwrap();
    unsafe { y::yices_parse_rational(text.as_ptr()) }
}

impl Yices {
    pub fn init() {
        unsafe { y::yices_init() }
    }

    pub fn thread_safe() -> bool {
        unsafe { y::yices_is_thread_safe() != 0 }
    }

    pub fn exit() {
        unsafe { y::yices_exit() }
    }

    pub fn new() -> Yices {
        unsafe {
            let cfg = y::yices_new_config();
            let logic = CString::new("QF_LRA").unwrap();
            assert_eq!(y::yices_default_config_for_logic(cfg, logic.as_ptr()), 0);
            let (mode, push_pop) = (CString::new("mode").unwrap(), CString::new("push-pop").unwrap());
            assert_eq!(y::yices_set_config(cfg, mode.as_ptr(), push_pop.as_ptr()), 0);
            let ctx = y::yices_new_context(cfg);
            assert!(!ctx.is_null());
            y::yices_free_config(cfg);
            Yices { ctx, unknowns: Vec::new() }
        }
    }

    fn formula(&self, row: &Row) -> y::term_t {
        unsafe {
            let mut parts: Vec<y::term_t> = vec![constant(&row.constant)];
            for (u, c) in &row.terms {
                parts.push(y::yices_mul(constant(c), self.unknowns[*u]));
            }
            let sum = y::yices_sum(parts.len() as u32, parts.as_ptr());
            if row.strict { y::yices_arith_gt0_atom(sum) } else { y::yices_arith_geq0_atom(sum) }
        }
    }

    fn assert(&self, rows: &[Row]) {
        for row in rows {
            unsafe { y::yices_assert_formula(self.ctx, self.formula(row)) };
        }
    }

    fn sat(&self) -> bool {
        unsafe { y::yices_check_context(self.ctx, std::ptr::null()) == y::smt_status::STATUS_SAT }
    }

    pub fn play(&mut self, script: &Script) -> Outcome {
        let mut outcome = Outcome { open: Vec::new(), sites: Vec::new(), report: Default::default(), _log: Vec::new() };
        unsafe { y::yices_reset_context(self.ctx) };
        let mut count = 0usize;
        for step in &script.steps {
            match step {
                Step::Unknown(..) | Step::Lasting(_) => {
                    if count == self.unknowns.len() {
                        self.unknowns.push(unsafe { y::yices_new_uninterpreted_term(y::yices_real_type()) });
                    }
                    count += 1;
                }
                Step::Dead(_) | Step::Glue { .. } => {}
                Step::Require(rows) => self.assert(rows),
                Step::Decide { taken, other, site, outcome: result } => {
                    let mut open = false;
                    for conjunction in other {
                        unsafe { y::yices_push(self.ctx) };
                        self.assert(conjunction);
                        open = self.sat();
                        unsafe { y::yices_pop(self.ctx) };
                        if open {
                            break;
                        }
                    }
                    outcome.open.push(Some(open));
                    outcome.sites.push((*site, *result));
                    self.assert(taken);
                }
            }
        }
        if !self.sat() {
            outcome.report.rejected += 1;
        }
        outcome
    }
}

impl Drop for Yices {
    fn drop(&mut self) {
        unsafe { y::yices_free_context(self.ctx) };
    }
}
