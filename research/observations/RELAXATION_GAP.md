# Relaxation gap of research/oracle/tiers/relax_minimal.json

Leave-one-out over 19 variants of the plan, 20000 runs each; ambiguous variants re-measured at 100000 runs. Run ids are deterministic per plan, so variants at one run count are directly comparable.

An edge is a partial-order constraint. A variant with no violations means the free interleaving reaches the failing schedule too rarely to see at this count; the lift is a lower bound on how much the ordering raises that probability, not a claim that the two events are adjacent. What sits between them is read off the dumped runs below.

| variant | runs | violations | rate | lift | class |
|---|---|---|---|---|---|
| full | 100000 | 27 | 0.00027 | - | - |
| -edge w1->allow_t1 | 20000 | 8 | 0.00040 | 1.0x | slack |
| -edge allow_t1->crash_nl | 20000 | 0 | 0.00000 | >=8 | necessary |
| -edge crash_nl->recover_nl | 20000 | 0 | 0.00000 | >=8 | necessary |
| -edge crash_nl->deliver_svc_1_to_2 | 20000 | 7 | 0.00035 | 1.1x | slack |
| -edge deliver_svc_1_to_2->crash_2 | 20000 | 0 | 0.00000 | >=8 | necessary |
| -edge crash_2->recover_2 | 20000 | 0 | 0.00000 | >=8 | necessary |
| -edge recover_nl->w2 | 20000 | 8 | 0.00040 | 1.0x | slack |
| -edge recover_2->w2 | 100000 | 6 | 0.00006 | 4.5x | contributes |
| -edge w2->deliver_svc_1_to_0 | 20000 | 0 | 0.00000 | >=8 | necessary |
| -edge w2->deliver_svc_2_to_0 | 100000 | 6 | 0.00006 | 4.5x | contributes |
| -edge deliver_svc_1_to_0->r1 | 20000 | 7 | 0.00035 | 1.1x | slack |
| -edge deliver_svc_1_to_0->r2 | 20000 | 8 | 0.00040 | 1.0x | slack |
| -edge deliver_svc_1_to_0->r3 | 20000 | 7 | 0.00035 | 1.1x | slack |
| -edge deliver_svc_2_to_0->r1 | 20000 | 8 | 0.00040 | 1.0x | slack |
| -edge deliver_svc_2_to_0->r2 | 20000 | 7 | 0.00035 | 1.1x | slack |
| -edge deliver_svc_2_to_0->r3 | 20000 | 8 | 0.00040 | 1.0x | slack |
| -event allow_t1 | 20000 | 0 | 0.00000 | >=8 | necessary |
| strict_timers=false | 100000 | 19 | 0.00019 | 1.4x | slack |
| no dependencies | 20000 | 0 | 0.00000 | >=8 | necessary |

Full plan: 8/20000 (0.00040); 27/100000 (0.00027). Lifts compare each variant with the full plan at its own run count.

## Failing run 26

```
[Step 0] [Client 3] Invocation: ClientInterface.Write
[Step 15] [Client 3] Response: ClientInterface.Write
[Step 16] [ System ] TimerFired: System.TimerFired
[Step 17] [Node 1] Dispatch Node.StartViewChange [tid=9]
[Step 17] [Node 1] Dispatch Node.StartViewChange [tid=10]
[Step 18] [ System ] Crash: System.Crash
[Step 19] [ System ] Recover: System.Recover
[Step 25] [Node 2] Enter Node.StartViewChange [tid=10]
[Step 25] [Node 2] Dispatch Node.StartViewChange [tid=16]
[Step 25] [Node 2] Dispatch Node.StartViewChange [tid=17]
[Step 26] [ System ] Crash: System.Crash
[Step 27] [ System ] Recover: System.Recover
[Step 28] [Client 3] Invocation: ClientInterface.Write
[Step 31] [Node 1] Enter Node.StartViewChange [tid=17]
[Step 31] [Node 1] Dispatch Node.StartViewChange [tid=23]
[Step 31] [Node 1] Dispatch Node.StartViewChange [tid=24]
[Step 33] [Node 2] Enter Node.StartViewChange [tid=24]
[Step 44] [Client 3] Response: ClientInterface.Write
[Step 45] [Node 0] Enter Node.StartViewChange [tid=23]
[Step 45] [Node 0] Dispatch Node.StartViewChange [tid=34]
[Step 45] [Node 0] Dispatch Node.StartViewChange [tid=35]
[Step 49] [Node 0] Enter Node.StartViewChange [tid=16]
[Step 50] [Client 3] Invocation: ClientInterface.Read
[Step 50] [Client 4] Invocation: ClientInterface.Read
[Step 50] [Client 5] Invocation: ClientInterface.Read
[Step 63] [Node 0] Enter Node.StartViewChange [tid=9]
[Step 66] [Node 2] Enter Node.StartViewChange [tid=35]
[Step 68] [Node 1] Enter Node.StartViewChange [tid=34]
[Step 80] [Client 4] Response: ClientInterface.Read
[Step 85] [Client 3] Response: ClientInterface.Read
[Step 90] [Client 5] Response: ClientInterface.Read
```

## Failing run 572

```
[Step 0] [Client 3] Invocation: ClientInterface.Write
[Step 13] [Client 3] Response: ClientInterface.Write
[Step 16] [ System ] TimerFired: System.TimerFired
[Step 17] [Node 1] Dispatch Node.StartViewChange [tid=9]
[Step 17] [Node 1] Dispatch Node.StartViewChange [tid=10]
[Step 18] [ System ] Crash: System.Crash
[Step 19] [ System ] Recover: System.Recover
[Step 25] [Node 2] Enter Node.StartViewChange [tid=10]
[Step 25] [Node 2] Dispatch Node.StartViewChange [tid=16]
[Step 25] [Node 2] Dispatch Node.StartViewChange [tid=17]
[Step 26] [ System ] Crash: System.Crash
[Step 27] [ System ] Recover: System.Recover
[Step 28] [Client 3] Invocation: ClientInterface.Write
[Step 31] [Node 1] Enter Node.StartViewChange [tid=17]
[Step 31] [Node 1] Dispatch Node.StartViewChange [tid=23]
[Step 31] [Node 1] Dispatch Node.StartViewChange [tid=24]
[Step 34] [Node 2] Enter Node.StartViewChange [tid=24]
[Step 48] [Client 3] Response: ClientInterface.Write
[Step 51] [Node 0] Enter Node.StartViewChange [tid=23]
[Step 52] [Node 0] Enter Node.StartViewChange [tid=16]
[Step 53] [Client 3] Invocation: ClientInterface.Read
[Step 53] [Client 4] Invocation: ClientInterface.Read
[Step 53] [Client 5] Invocation: ClientInterface.Read
[Step 76] [Client 4] Response: ClientInterface.Read
[Step 78] [Client 5] Response: ClientInterface.Read
[Step 91] [Client 3] Response: ClientInterface.Read
```

## Failing run 1212

```
[Step 0] [Client 3] Invocation: ClientInterface.Write
[Step 9] [Client 3] Response: ClientInterface.Write
[Step 16] [ System ] TimerFired: System.TimerFired
[Step 17] [Node 1] Dispatch Node.StartViewChange [tid=9]
[Step 17] [Node 1] Dispatch Node.StartViewChange [tid=10]
[Step 18] [ System ] Crash: System.Crash
[Step 19] [ System ] Recover: System.Recover
[Step 24] [Node 2] Enter Node.StartViewChange [tid=10]
[Step 24] [Node 2] Dispatch Node.StartViewChange [tid=16]
[Step 24] [Node 2] Dispatch Node.StartViewChange [tid=17]
[Step 25] [ System ] Crash: System.Crash
[Step 26] [ System ] Recover: System.Recover
[Step 27] [Client 3] Invocation: ClientInterface.Write
[Step 33] [Node 1] Enter Node.StartViewChange [tid=17]
[Step 33] [Node 1] Dispatch Node.StartViewChange [tid=24]
[Step 33] [Node 1] Dispatch Node.StartViewChange [tid=25]
[Step 38] [Node 2] Enter Node.StartViewChange [tid=25]
[Step 50] [Client 3] Response: ClientInterface.Write
[Step 51] [Node 0] Enter Node.StartViewChange [tid=24]
[Step 52] [Node 0] Enter Node.StartViewChange [tid=9]
[Step 54] [Node 0] Enter Node.StartViewChange [tid=16]
[Step 55] [Client 3] Invocation: ClientInterface.Read
[Step 55] [Client 4] Invocation: ClientInterface.Read
[Step 55] [Client 5] Invocation: ClientInterface.Read
[Step 85] [Client 3] Response: ClientInterface.Read
[Step 87] [Client 5] Response: ClientInterface.Read
[Step 89] [Client 4] Response: ClientInterface.Read
```

