#!/usr/bin/env bash
# Validates the shared .agents/skills layout and its .claude compatibility
# shims. Prints each failing check; exits nonzero if any check fails.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

fails=0
fail() {
    echo "FAIL: $*"
    fails=$((fails + 1))
}

# 1. Every skill directory has a SKILL.md with matching name metadata.
names=""
for dir in .agents/skills/*/; do
    skill="$(basename "$dir")"
    md="$dir/SKILL.md"
    if [ ! -f "$md" ]; then
        fail "$md missing"
        continue
    fi
    name="$(sed -n 's/^name:[[:space:]]*//p' "$md" | head -1)"
    if [ -z "$name" ]; then
        fail "$md has no name: metadata line"
    elif [ "$name" != "$skill" ]; then
        fail "$md name '$name' does not match directory '$skill'"
    fi
    names="$names$name
"
done

# 2. Skill names are unique.
dupes="$(printf '%s' "$names" | sort | uniq -d)"
[ -n "$dupes" ] && fail "duplicate skill names: $dupes"

# 3. Every symlink under .claude resolves (skip generated worktrees).
while IFS= read -r link; do
    [ -e "$link" ] || fail "broken symlink: $link"
done < <(find .claude -path .claude/worktrees -prune -o -type l -print)

# 4. Referenced files under docs/agent/, references/, scripts/ exist.
#    Extracts backtick-quoted paths from skill bodies; reference/ paths are
#    relative to the skill directory, the rest to the repository root.
for md in .agents/skills/*/SKILL.md; do
    dir="$(dirname "$md")"
    while IFS= read -r ref; do
        case "$ref" in
        reference/*|references/*) base="$dir/$ref" ;;
        *) base="$ref" ;;
        esac
        [ -e "$base" ] || fail "$md references missing file: $ref"
    done < <(grep -o '`\(docs/agent\|references\|reference\|scripts\)/[^`]*`' "$md" | tr -d '`' | sort -u)
done

# 5. Skill bodies do not mention .claude/ paths. The lite research-loop skill
#    keeps its existing operational text and is whitelisted.
for md in .agents/skills/*/SKILL.md; do
    case "$md" in
    .agents/skills/research-loop-lite/*) continue ;;
    esac
    if grep -qn '\.claude/' "$md"; then
        fail "$md mentions .claude/ paths:"
        grep -n '\.claude/' "$md" | sed 's/^/    /'
    fi
done

# 6. CLAUDE.md and the .claude/rules symlinks resolve.
for link in CLAUDE.md .claude/rules/debugging.md .claude/rules/language.md; do
    if [ ! -L "$link" ]; then
        fail "$link is not a symlink"
    elif [ ! -e "$link" ]; then
        fail "broken symlink: $link"
    fi
done

if [ "$fails" -gt 0 ]; then
    echo "$fails check(s) failed"
    exit 1
fi
echo "agent layout OK"
