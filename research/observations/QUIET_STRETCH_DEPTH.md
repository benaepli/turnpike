# Prefix depth by quiet stretch

A run's **longest quiet stretch** is the longest span of consecutive deliveries
whose handler changed no node's state. The simulator records it per run id when
`quiet_stretch_telemetry` is on, alongside the histogram of the same quantity
split by how the run ended; the grader assigns prefix depth per run id. This
report is the join of the two, which no existing counter can stand in for: the
ladder pools over the stretch, and the termination tallies see how a run ended
but not how long it had been quiet before it did.

## The question

Ending a quiet run early and spending its remaining budget on a fresh run is
worth something only if depth stops appearing above some stretch. If deep runs
are as likely to have gone quiet as shallow ones, or more likely, then an abort
rule discards the runs that were still producing, and every calibration of the
threshold is a different way of doing that.

## Producing it

    ./spur/target/release/spur explore bin/spur/VR.spur -e campaign \
      --config scheduler_configs/loop/general_vr.json \
      --output-dir tmp/loop/quiet-probe -y \
      --set quiet_stretch_telemetry=true

    node research/observations/quiet_stretch_depth.mjs --corpus tmp/loop/quiet-probe

The switch is off by default and is not set in any config the evaluator loads,
so the counters cost nothing outside a probe. It rides the delivery-effect
probe, so `stats` and `emit_acted_fraction` must both be on, which they are in
the general config.

## The rule the report applies

A cut separates when at least 5% of runs lie above it and the 95% upper bound
on P(depth>=6) above it is under a fifth of the corpus rate. If some cut
separates, an abort rule has a calibrated threshold and a measured payoff. If
none does, quiescence does not predict a run's failure to produce depth, and no
threshold rescues an abort rule built on it.

<!-- generated below -->
