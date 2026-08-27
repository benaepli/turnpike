# Channel delivery order at baseline

Does the explorer ever deliver two messages between the same ordered pair of
nodes in an order other than the one they were sent in, and if so how often?

Answered offline from the event trace the explorer already writes. No simulator
change, no config field, no counter in the delivery path.

- probe: `spur/spur-core/tests/message_order_probe.rs` (`cargo test -p spur-core
  --test message_order_probe -- --nocapture`)
- trace source: `spur explore bin/spur/VR.spur --config
  scheduler_configs/loop/general_vr.json`, one session
- session: 5400 runs, 11,357,111 trace rows

## How the trace answers it

A call to a `@trace` function emits a `Dispatch` row on the sending node
immediately before the message is queued, and the handler that eventually runs
it emits an `Enter` row carrying the same `trace_id` on the receiving node.
Within a run `seq_num` is the emission index, so it totally orders both events.
Send order and delivery order for every message are therefore already on disk,
along with both endpoints. Every message-carrying handler in `VR.spur` is
`@trace`-annotated, so coverage is complete for inter-replica traffic.

## The number

| quantity | count | rate |
| --- | --- | --- |
| messages sent | 4,413,482 | |
| delivered to another node | 2,828,098 | 64.1% of sent |
| never delivered | 964,743 | 21.9% of sent |
| node pairs carrying >=2 messages in one run | 21,997 | |
| ... with at least one out-of-order pair | 18,975 | **86.3%** |
| runs with at least one out-of-order pair | 4,650 | **86.1%** |
| consecutively sent pairs on one channel | 2,799,176 | |
| ... that arrived swapped | 537,178 | **19.2%** |
| deliveries that overtook an earlier send on the same channel | 1,587,918 | **56.1%** |

The all-pairs inversion rate is 0.436% (2,541,507 of 583,254,014), but that
statistic is diluted by channel length: a channel carrying n messages
contributes n(n-1)/2 pairs, nearly all of them separated by so much simulated
time that no scheduler would reorder them. The adjacent-pair and overtaking
rates are the ones to read.

## Decision: close the reordering axis

Delivery between a pair of nodes is already close to unordered. One delivery in
two arrives ahead of a message the same sender queued earlier; one consecutive
send pair in five arrives swapped; five runs in six contain a reordering. There
is no scarcity here for a mechanism to relieve.

Any hypothesis whose mechanism is "make the scheduler reorder messages on a
channel", or whose justification is "FIFO order is suppressing an interleaving
the bug needs", is arguing against this measurement and should not be funded.
That includes ordering axes added to the coverage key: an event occurring in
86% of runs cannot discriminate between runs.

This is the same shape as the falsified purgatory and orphan families, and it
now has a direct cause rather than an inference from six null results. Those
mechanisms delayed and reordered messages into a receiver in a system where
reordering was already the common case, so they bought nothing that was scarce.

## Two side findings

**21.9% of sent messages are never delivered.** Roughly one message in five is
dispatched and the run ends, or the target is gone, before its handler runs.
That fraction is large enough that "the message was queued" and "the message was
acted on" are very different populations, which is consistent with the measured
absorption gap and is worth keeping in mind when a mechanism counts sends rather
than effects.

**`max_iterations` is the per-run step budget, not a run count.** Overriding it
to a small value to shorten a run does not shorten the session; it truncates
every run in it. At `max_iterations=3` the same session still reported 5400 runs
and still wrote a trace file, but the runs contained only node initialisation:
16,200 `Init` handlers and 568 `Prepare` sends across the whole session, against
68,908 `Prepare` sends at the real setting. A session shortened that way looks
valid and measures nothing. To shorten a smoke run, cut `num_runs_per_config` or
the config grid instead.
