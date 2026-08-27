# Loop explorer configs

A runner loads exactly the config file it is pointed at. Adding a config file
here does nothing on its own: nothing scans the directory, so a file that no
runner names is inert, and a change expressed only as a new sibling file is a
change that never ran. Config work has to edit a file that is actually loaded,
or vary a loaded file through an override.

## Varying one field without a sibling file

`spur explore` accepts field overrides applied to the loaded config before it
is parsed and key-checked:

```sh
spur explore bin/spur/VR.spur -c scheduler_configs/loop/general_vr.json \
  -o tmp/loop/sweep-020 -y --set purgatory.delay_probability=0.20

SPUR_CONFIG_SET='purgatory.delay_probability=0.20;num_crashes.max=2' \
  spur explore bin/spur/VR.spur -c scheduler_configs/loop/general_vr.json \
  -o tmp/loop/sweep-020 -y
```

Both forms take `path.to.field=value`, dot-separated into the config object.
Missing intermediate objects are created, so a knob that is absent from the
file and relying on its default can still be set. The value is read as JSON
when it parses (`true`, `12`, `[5,300]`) and as a plain string otherwise. The
environment variable is applied first and command-line `--set` second, so a
flag wins a conflict; a repeated path takes its last value. Overrides run
before `strict_config_keys`, so a misspelled top-level field is rejected the
same way it would be inside the file.

The environment form exists for runners that build their own argument list and
cannot be given a new flag. Every applied override is printed at startup and
logged at info level, so a session's log records which values it actually ran.
