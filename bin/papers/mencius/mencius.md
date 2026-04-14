/_ Pseudo code of Mencius at server p. _/

variable: proposed[];
variable: expected ← 0;
variable: index ← min{i : owner(i) = p};
variable: est_index[];
variable: need_to_skip[];

DownCall OnClientRequest(v)
begin
forall q ∈ {0, ..., n-1} do
CancelTimer(q);
need_to_skip[q] ← {};
end
DownCall Suggest(index, v);
proposed[index] ← v;
index ← min{i : owner(i) = p ∧ i > index};
end

UpCall OnAcceptSuggestion(i, q)
begin
QSkipSet ← {j : est_index[q] ≤ j < i ∧ owner(j) = q};
forall j ∈ QSkipSet do
learned(j) ← no-op;
Call CheckCommit;
end
est_index[q] ← min{j : j > i ∧ owner(j) = q};
end

UpCall OnSuggestion(i)
begin
q ← owner(i);
QSkipSet ← {j : est_index[q] ≤ j < i ∧ owner(j) = q};
forall j ∈ QSkipSet do
learned(j) ← no-op;
Call CheckCommit;
end
est_index[q] ← min{j : j > i ∧ owner(j) = q};

    SkipSet ← {j : index ≤ j < i ∧ owner(j) = p};
    forall k ∈ SkipSet do
        learned(k) ← no-op;
        Call CheckCommit;
    end

    forall k ∈ {r : 0 ≤ r < n-1 ∧ r ≠ p ∧ r ≠ q} do
        if need_to_skip[k] = {} then
            SetTimer(k, τ);
        end
        need_to_skip[k] ← need_to_skip[k] ∪ SkipSet;
        if size(need_to_skip[k]) > α then
            Call SendSkip(k);
        end
    end
    index ← min{j : owner(j) = p ∧ j > i};

end

DownCall OnSuspect(q)
begin
C_q = min{i : owner(i) = q ∧ learned(i) = ⊥};
if C_q < index + β then
RevokeSet ← {i : C_q ≤ i ≤ index + 2β ∧ owner(i) = q ∧ learned(i) = ⊥};
forall k ∈ RevokeSet do
DownCall Revoke(k);
end
end
end

UpCall OnLearned(i, v)
begin
if owner(i) = p ∧ proposed[i] ≠ v then
Call OnClientRequest(proposed[i]);
end
Call CheckCommit;
end

OnTimeout(k)
begin
Call SendSkip(k);
end

Procedure SendSkip(k)
begin
CancelTimer(k);
forall q ∈ need_to_skip[k] do
DownCall Skip(q);
end
need_to_skip[k] ← {};
end

Procedure CheckCommit
begin
while learned(expected) ≠ ⊥ do
v ← learned(expected);
if v ≠ no-op ∧ v ∉ {learned(i) : 0 ≤ i < expected} then
UpCall OnCommit(v);
end
expected ← expected + 1;
end
end
