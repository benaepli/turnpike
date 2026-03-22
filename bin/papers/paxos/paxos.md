## 1. Replica
The replica maintains the state of the application and handles client requests.

```text
process Replica(leaders, initial_state)
    var state := initial_state, slot_num := 1;
    var proposals := ∅, decisions := ∅;

    function propose(c)
        if ∄s : (s, c) ∈ decisions then
            s' := min{s | s ∈ N+ ∧ ∄c' : (s, c') ∈ proposals ∪ decisions};
            proposals := proposals ∪ {(s', c)};
            ∀λ ∈ leaders : send(λ, (propose, s', c));
        end if
    end function

    function perform(⟨κ, cid, op⟩)
        if ∃s : s < slot_num ∧ (s, ⟨κ, cid, op⟩) ∈ decisions then
            slot_num := slot_num + 1;
        else
            (next, result) := op(state);
            atomic
                state := next;
                slot_num := slot_num + 1;
            end atomic
            send(κ, (response, cid, result));
        end if
    end function

    for ever
        switch receive()
            case (request, c):
                propose(c);
            case (decision, s, c):
                decisions := decisions ∪ {(s, c)};
                while ∃c' : (slot_num, c') ∈ decisions do
                    if ∃c'' : (slot_num, c'') ∈ proposals ∧ c'' ≠ c' then
                        propose(c'');
                    end if
                    perform(c');
                end while;
        end switch
    end for
end process
```

---

## 2. Acceptor
Acceptors act as the fault-tolerant memory of the system.

```text
process Acceptor()
    var ballot_num := ⊥, accepted := ∅;

    for ever
        switch receive()
            case (p1a, λ, b):
                if b > ballot_num then
                    ballot_num := b;
                end if;
                send(λ, (p1b, self(), ballot_num, accepted));

            case (p2a, λ, ⟨b, s, c⟩):
                if b ≥ ballot_num then
                    ballot_num := b;
                    accepted := accepted ∪ {(b, s, c)};
                end if
                send(λ, (p2b, self(), ballot_num));
        end switch
    end for
end process
```

---

## 3. Commander and Scout
These are thread-like processes spawned by the Leader to handle different phases of the Synod protocol.

### Commander
```text
process Commander(λ, acceptors, replicas, (b, s, c))
    var waitfor := acceptors;
    ∀α ∈ acceptors : send(α, (p2a, self(), (b, s, c)));

    for ever
        switch receive()
            case (p2b, α, b'):
                if b' = b then
                    waitfor := waitfor − {α};
                    if |waitfor| < |acceptors|/2 then
                        ∀ρ ∈ replicas : send(ρ, (decision, s, c));
                        exit();
                    end if;
                else
                    send(λ, (preempted, b'));
                    exit();
                end if;
        end switch
    end for
end process
```

### Scout
```text
process Scout(λ, acceptors, b)
    var waitfor := acceptors, pvalues := ∅;
    ∀α ∈ acceptors : send(α, (p1a, self(), b));

    for ever
        switch receive()
            case (p1b, α, b', r):
                if b' = b then
                    pvalues := pvalues ∪ r;
                    waitfor := waitfor − {α};
                    if |waitfor| < |acceptors|/2 then
                        send(λ, (adopted, b, pvalues));
                        exit();
                    end if;
                else
                    send(λ, (preempted, b'));
                    exit();
                end if;
        end switch
    end for
end process
```

---

## 4. Leader
The leader coordinates the protocol by spawning scouts and commanders.

```text
process Leader(acceptors, replicas)
    var ballot_num := (0, self()), active := false, proposals := ∅;
    spawn(Scout(self(), acceptors, ballot_num));

    for ever
        switch receive()
            case (propose, s, c):
                if ∄c' : (s, c') ∈ proposals then
                    proposals := proposals ∪ {(s, c)};
                    if active then
                        spawn(Commander(self(), acceptors, replicas, (ballot_num, s, c)));
                    end if
                end if

            case (adopted, ballot_num, pvals):
                proposals := proposals ⊲ pmax(pvals);
                ∀⟨s, c⟩ ∈ proposals : 
                    spawn(Commander(self(), acceptors, replicas, (ballot_num, s, c)));
                active := true;

            case (preempted, ⟨r', λ'⟩):
                if (r', λ') > ballot_num then
                    active := false;
                    ballot_num := (r' + 1, self());
                    spawn(Scout(self(), acceptors, ballot_num));
                end if
        end switch
    end for
end process
```
