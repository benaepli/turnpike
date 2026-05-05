/_ Pseudo code of Protocol P at server p (Appendix B). _/

/_ Protocol P runs a series of Coordinated Paxos. It commits a value
   learned in instance i once all instances prior to i have been learned
   and committed. The following code handles duplication by checking for
   duplications before committing. Other techniques, such as assuming
   idempotent requests, can also be used. _/

/_ Note that besides the original arguments, all upcalls/downcalls
   from/to Coordinated Paxos also have an additional argument i that
   specifies the simple consensus instance number. _/

/_ Protocol P provides two APIs to its applications. The application
   downcalls OnClientRequest to submit a request to the state machine.
   When a value is chosen, P upcalls OnCommit to notify the application. _/

/_ Function owner(i) returns the coordinator of instance i. _/
/_ Function learned(i) returns a reference to the learned variable of
   the ith simple consensus instance. _/

variable: proposed[];                          /_ instance → value initially suggested by p; ⊥ initially _/
variable: index ← min{i : owner(i) = p};       /_ next instance to suggest a value to _/
variable: expected ← 0;                        /_ smallest instance whose value is not yet learned _/

DownCall OnClientRequest(v)
begin
    DownCall Suggest(index, v);                /_ Rule 1: p suggests v to instance index _/
    proposed[index] ← v;
    index ← min{i : owner(i) = p ∧ i > index};
end

UpCall OnSuggestion(i)
/_ Rule 2: on receiving a SUGGEST message for instance i,
   p skips all unused instances prior to i. _/
begin
    SkipSet ← {k : k ≥ index ∧ k < i ∧ owner(k) = p};
    forall k ∈ SkipSet do
        DownCall Skip(k);                      /_ Skip instance k _/
    end
    index ← min{k : owner(k) = p ∧ k > i};
end

DownCall OnSuspect(q)
/_ Rule 3: when suspecting q has failed, p revokes all
   instances smaller than index that are coordinated by q. _/
begin
    RevokeSet ← {i : owner(i) = q ∧ i < index ∧ learned(i) = ⊥};
    forall k ∈ RevokeSet do
        DownCall Revoke(k);                    /_ Revoke instance k _/
    end
end

Procedure CheckCommit
/_ Check if a new value can be committed. _/
begin
    while learned(expected) ≠ ⊥ do
        v ← learned(expected);
        if v ≠ no-op ∧ v ∉ {learned(i) : 0 ≤ i < expected} then
            /_ Commit v only if it is not a no-op and not a duplicate. _/
            UpCall OnCommit(v);
        end
        expected ← expected + 1;
    end
end

UpCall OnLearned(i, v)
/_ Upon instance i learns value v. _/
begin
    if owner(i) = p ∧ proposed[i] ≠ v then
        /_ Rule 4: v must be no-op; re-suggest proposed[i]. _/
        Call OnClientRequest(proposed[i]);
    end
    Call CheckCommit;
end


/_ ─── Coordinated Paxos at server p (Appendix A) ─── _/

/_ Each round of Coordinated Paxos is assigned to one of the servers.
   The round number is also called ballot number. _/
/_ Function owner(r) returns the server ID of the owner of round
   (ballot number) r. _/
/_ Note that this is only the pseudo code for one instance of
   Coordinated Paxos. _/

/_ PREPARE(b):       PREPARE message for ballot number b. _/
/_ ACK(b, ab, av):   acknowledges PREPARE(b); ab is the highest ballot
                     the sender has accepted, av is the value accepted
                     for ballot ab. _/
/_ PROPOSE(b, v):    proposes value v with ballot number b. _/
/_ ACCEPT(b, v):     acknowledges PROPOSE(b, v); the sender has
                     accepted v for ballot b. _/
/_ LEARN(v):         informs other servers that v has been chosen for
                     this consensus instance. _/

/_ learner state _/
variable: learned ← ⊥;                         /_ no value learned initially _/
variable: learner_history ← {};                /_ no peer has accepted any value _/

/_ proposer state _/
variable: prepared_history ← {};               /_ no prepared history initially _/

/_ acceptor state _/
variable: prepared_ballot ← 0;                 /_ all servers initially prepared at ballot 0 _/
variable: accepted_ballot ← −1;                /_ no ballot accepted initially _/
variable: accepted_value ← ⊥;                  /_ no value accepted initially _/

/_ Coordinator can call either Suggest or Skip. _/
DownCall Suggest(v)                            /_ Coordinator proposes value v. _/
begin
    Broadcast PROPOSE(0, v);
end

DownCall Skip()                                /_ Coordinator proposes no-op. _/
begin
    Broadcast PROPOSE(0, no-op);
end

DownCall Revoke()                              /_ Non-coordinator starts to propose no-op. _/
begin
    ballot ← Choose b : owner(b) = p ∧ b > prepared_ballot ∧ b > accepted_ballot;
    /_ Choose a ballot owned by p, larger than any ballot p has seen. _/
    Broadcast PREPARE(ballot);                 /_ Start phase 1 with a higher ballot. _/
end

OnMessage PROPOSE(b, v) From q OnCondition learned = ⊥
begin
    if b = 0 ∧ v = no-op then
        /_ Coordinator skips; p learns no-op immediately. _/
        learned ← no-op;
        UpCall OnLearned(no-op);
    else if prepared_ballot ≤ b ∧ accepted_ballot < b then
        /_ p accepts (b, v). _/
        if b = 0 then
            /_ This is a SUGGEST message. _/
            UpCall OnSuggestion;               /_ upcall interface for protocol P / Mencius _/
        end
        accepted_ballot ← b;
        accepted_value ← v;
        Send ACCEPT(b, v) To q;
    end
end

OnMessage ACCEPT(b, v) From q OnCondition learned = ⊥
begin
    if b = 0 then
        /_ This ACCEPT acknowledges a SUGGEST. _/
        UpCall OnAcceptSuggestion(q);          /_ upcall interface for Mencius (not used by Protocol P) _/
    end
    learner_history ← learner_history ∪ {⟨b, v, q⟩};
    LSet ← {⟨e1, e2, e3⟩ : e1 = b ∧ ⟨e1, e2, e3⟩ ∈ learner_history};
    if size(LSet) = ⌈(n + 1)/2⌉ then
        /_ A quorum has accepted v; the value is chosen. _/
        Broadcast LEARN(v);
    end
end

OnMessage ACK(b, a, v) From q OnCondition learned = ⊥
begin
    prepared_history ← prepared_history ∪ {⟨b, a, v, q⟩};
    PSet ← {⟨e1, e2, e3, e4⟩ : e1 = b ∧ ⟨e1, e2, e3, e4⟩ ∈ prepared_history};
    if size(PSet) = ⌈(n + 1)/2⌉ then
        /_ A quorum is prepared, ready to propose. _/
        ha ← max{a : ⟨−, a, −, −⟩ ∈ PSet};
        hvset ← {v : ⟨−, ha, v, −⟩ ∈ PSet};
        hv ← Choose v : v ∈ hvset;             /_ hvset has one unique element _/
        if hv = ⊥ then
            /_ No value chosen yet; propose no-op. _/
            Broadcast PROPOSE(b, no-op);
        else
            /_ Must propose hv. _/
            Broadcast PROPOSE(b, hv);
        end
    end
end

OnMessage PREPARE(b) From q OnCondition learned = ⊥
begin
    if b > prepared_ballot then
        prepared_ballot ← b;
        Send ACK(b, accepted_ballot, accepted_value) To q;
    end
end

OnMessage LEARN(v) From q OnCondition learned = ⊥
begin
    learned ← v;
    UpCall OnLearned(v);
end

OnMessage ANY From q OnCondition learned ≠ ⊥
begin
    if the incoming message is not a LEARN message then
        Send LEARN(learned) To q;
    end
end
