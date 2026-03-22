As described in the technical report, the specific failure trace for **Viewstamped Replication Revisited** involves a three-replica system where a new leader (NL) unknowingly overwrites the decisions of an old leader (OL).

The exact steps of the trace are as follows:

* **Step 1**: Initially, NL suspects OL of failing and sends a `START-VIEW-CHANGE` message to node 1 to switch to view 1.
* **Step 2**: NL crashes immediately after sending this message before node 1 receives it then immediately initiates recovery. It sends `RECOVERY` messages and receives `RECOVERY-RESPONSE` messages from OL and node 1, both of which are in view 0—so NL recovers in view 0.
* **Step 3**: Node 1 receives the `START-VIEW-CHANGE` message sent by the previous incarnation of NL. Node 1 sends a `START-VIEW-CHANGE` message to NL for view 1. Because node 1 has a quorum of `START-VIEW-CHANGE` messages for view 1 (its own and the one from NL), it also sends a `DO-VIEW-CHANGE` message to NL. Both messages are delayed by the network.
* **Step 4**: Node 1 crashes and immediately recovers, sending `RECOVERY` messages to and receiving responses from OL and NL — both of which are in view 0.
* **Step 5**: NL receives `START-VIEW-CHANGE` and `DO-VIEW-CHANGE` messages from node 1. It has a quorum of `START-VIEW-CHANGE` messages, so it sends a `DO-VIEW-CHANGE` message for view 1. This is enough for it to complete the view change.
* **Step 6**: It sends a `START-VIEW` message.
* **Step 7**: Until the `START-VIEW` message is received, nodes OL and 1 are still in view 0 and do not believe a view change is in progress. Thus, they can commit new operations, which the new leader NL will not know about, leaving the system in an inconsistent state.