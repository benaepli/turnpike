# Call-graph profile: spur 12b7582 (operator diagnostic, not a grader artifact)

Recorded outside the grader, which deliberately records no call graph. Frame
pointers (`-C force-frame-pointers=yes`) into a separate target directory;
the graded baseline binary was not touched. 8 threads rather than 30 so the
recording stays cheap - caller SHARES are the quantity wanted and are stable
across thread count, while contention effects are not and must not be read
from this file. 45s of the campaign workload on bin/spur/VR.spur, -F 99.

Validity check, which the earlier DWARF attempt failed: the root frames
resolve. run_single_simulation reads 84.27% inclusive and exec_plan 79.71%.
A call graph whose root is not near-total has broken stacks and every
attribution below it is fiction.

## Inclusive cost model (children %, 8 threads)

```
exec_plan                                 79.71
  schedule_runnable                       73.29   (self ~5)
    [scheduler side, non-exec]           ~15.7
      select_within_queue                  3.71   (self 1.07)
      note_delivery                        3.63   (self 0.49)
      walk_recovery_placebo                1.37   (self 1.08)
      audit_multiplier_authority          <1
      timer_context                       <1
      pending_deliveries_to               <1
    exec                                  57.64
      execute_common_label                49.30
        eval                              29.52
        make_local_env                    13.05   (self 2.33)
          Value::new                      12.89
history ParquetWriter thread               7.09
```

## What this settles

**The interpreter is the cost, not the scheduler.** schedule_runnable
carries 73.29% inclusive against about 5% self: it is overwhelmingly the
caller of exec, not a cost in itself. The scheduler's own per-step work,
including every observation mechanism, is about 15.7% and no single
observation mechanism reaches 1.4%.

**Local environment construction is 13.05% of total runtime.** make_local_env
is 13.05% inclusive with only 2.33% self, and Value::new underneath it is
12.89%. Building a fresh EcoVec-backed Env for every interpreted call is the
largest single nameable structural cost in the process.

**The iteration 2 mystery is answered.** EcoVec::make_unique totals 3.76%,
of which 2.20% arrives through Value::new from eval from make_local_env from
execute_common_label. The node env clone that exec-node-env-in-place attacked
was a minority of that symbol, which is exactly why removing it moved
make_unique only from 1.45% to 1.33% while its counter proved it fired 200
times per run.

**Three standing assumptions are refuted.** The per-step observation
machinery is not where the scheduler's time goes. pending_deliveries_to,
which iteration 3 scored at gain 6 on a 1.28% standalone symbol, is below
the 1% cutoff here. And the theory that schedule_runnable's flat self time
was per-step fixed overhead was wrong in the direction that matters: the
flat profile's 10.63% self is real, but it sits under an inclusive 73% whose
bulk is the interpreter it calls.

## Callers of EcoVec::make_unique
```
     3.76%  spur     spur           [.] <ecow::vec::EcoVec<core::values::Value<hash_utils::NoHashing>>>::make_unique
            |          
             --2.20%--<core::values::Value<hash_utils::NoHashing>>::new
                       |          
                        --2.15%--core::eval::eval
                                  |          
                                   --2.03%--core::eval::make_local_env
                                             |          
                                              --1.80%--core::exec::execute_common_label, rng::RecRng<rng::RecordRng>>
                                                        |          
                                                         --1.60%--core::exec::exec, rng::RecRng<rng::RecordRng>>
                                                                   core::scheduler::schedule_runnable, rng::RecRng<rng::RecordRng>>
```

## Scaling measurement (operator diagnostic, 60s campaign, baseline binary)

Measured with /usr/bin/time -v on the graded baseline binary and workload.
writers = rayon threads div_ceil 8 (history.rs:573-575). The box has 32
logical CPUs.

| threads | writers | CPU busy (cores) | rps | rps per busy core |
|---|---|---|---|---|
| 8  | 1 | 6.9  | 1246 | 180 |
| 16 | 2 | 11.7 | 1475 | 126 |
| 30 | 4 | 21.9 | ~2100 | 96 |
| 48 | 6 | 25.9 | 2154 | 83 |
| 64 | 8 | 27.9 | 2127 | 76 |

### The session is memory bound, not writer bound and not IO bound

Three things were ruled out by measurement rather than by argument.

**Not disk.** The same 30-thread configuration writing to /dev/shm reads
21.8 busy cores against 21.9 on disk, and 2083 runs per second. Identical.

**Not the history writer.** Doubling the writer threads from four to eight,
by raising the rayon thread count to 64, moves throughput from about 2083
to 2127 runs per second. Flat. A writer-throttled session would have jumped.
This refutes the premise of the history-writer hypothesis before it was
built.

**Not idle waiting.** This is the decisive column. Throughput per BUSY core
falls from 180 to 96 to 76 as threads scale. Threads that were merely
blocked would leave the remaining busy cores at full rate; instead every
busy core does the same work at roughly half speed. That is bandwidth and
cache contention, not blocking.

### What this means for the goal

The lever is bytes touched per run, not instructions retired per run. A
change that removes memory traffic frees bandwidth for all thirty threads
and can therefore pay more than its own CPU share suggests; a change that
removes only instruction count pays less. This is the same conclusion the
closed global-allocator-swap pool entry reached from the other direction -
"the bytes moved are the cost, not the allocator servicing them" - now
established independently and at the level of the whole session rather than
of one allocator.

It also explains the epoch's central puzzle. Three iterations produced five
candidates and zero merges, and the two graded ones removed real work that
the clock did not reward. Both removed instructions rather than bytes: a
copy-on-write fault that the counter proved fired but whose buffer was
small, and a table scan whose work relocated into its caller. Under a
bandwidth ceiling, neither would pay whatever the counter said.

### Caveat

CPU busy figures include the writer threads, so the per-core rates are not
purely per-worker. The trend across a 8x range of thread counts is far
larger than that accounting error. The 8-thread call graph above remains
valid for caller shares and remains invalid for contention, as stated.
