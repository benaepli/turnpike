# Modules and Crates for Spur

Design document. Every line reference below is to the tree at commit 9981bd2
(repository root /home/benaepli/Rust/turnpike, `spur` submodule at eb9c26b)
unless stated otherwise. Paths under `spur/` are relative to the repository
root.

Contents

1. Summary and goals
2. Language surface
3. Static semantics
4. Crates and loading
5. Import resolution
6. Standard library
7. Compiled program and downstream surfaces
8. Tooling
9. Worked examples and migration
10. What modules do not solve
11. Decisions
12. Phased implementation plan
- Appendix A. Rejected alternatives
- Appendix B. Prior art: tygr

---

## 1. Summary and goals

### 1.1 What exists today

A Spur program is one file. The entry point is `compile(input: &str, name: &str)`
(`spur/spur-core/src/compiler.rs:100`), which lexes one string, parses one token
stream, and hands one `Program` (`spur/spur-core/src/parser.rs:30-33`) to one
`Resolver`.

- Names live in flat, program-wide scopes: `type_scopes` (a stack whose bottom
  frame holds every declared type and every role), `role_scope`,
  `global_func_scope`, and per-role `role_func_scopes`
  (`spur/spur-core/src/analysis/resolver.rs:306-323`).
- Every declaration mints from one counter, `Resolver::next_id`
  (`resolver.rs:387-393`). `NameId` (`spur/spur-ast/src/name.rs:9`) is a plain
  `usize` with no crate or module component.
- `Span` is `SimpleSpan<usize>` (`spur/spur-ast/src/span.rs:3`). It carries byte
  offsets and nothing that says which file they are offsets into.
- The compiled function name is `Role.Func`, built in five places from one
  qualifier map (`spur/spur-core/src/compiler/cfg.rs:266`, `:277`, `:293`,
  `:415`, `:1330`, `:1388`, `:1489`). Free functions get the qualifier
  `"__free"` (`cfg.rs:277`).
- Composition therefore happens by copy. `bin/spur/panel/` holds 14 files that
  are near-duplicates of `bin/spur/Raft.spur` and `bin/spur/Paxos.spur`; the 5
  files under `bin/spur/mencius/` are another family. A single-file sharded
  deployment must inline the whole of Raft and rename its roles and types by
  hand.

### 1.2 Goals

1. **A file is a unit of reuse.** A protocol lives in one file, is imported by
   name, and is used without renaming its roles or types.
2. **The module tree is the directory tree.** There is nothing else to keep in
   sync: no `mod` declarations, no module list, no search path, no `#[path]`.
   A reader who can see the directory can compute every module path. A crate's
   `spur.json` says where the tree starts and what other trees are reachable;
   it never names a module (Section 4.1).
3. **One resolution path.** A single-file spec is a one-module program resolved
   by the same code as a twenty-module program. There is no second path to keep
   correct.
4. **Identity is unchanged.** `NameId` stays a single program-wide counter,
   across every module of every crate. Modules change lookup, never identity,
   so every structure keyed by `NameId` -- `role_func_scopes`,
   `TopologyMetadata.tags`, `Type::Role(NameId, _)`, `Program.rpc` -- keeps
   working with no change.
5. **The simulator core is untouched.** Nothing in `simulator/core/` changes.
   The only compile-time outputs that change are display strings, and only for
   programs that actually use more than one module.
6. **No backwards compatibility.** Every spec under `bin/spur` and every JSON
   under `scheduler_configs/` may be rewritten. In practice none of them needs
   to be: a one-file spec is a one-crate, one-module program with an implicit
   manifest and byte-identical names (Sections 4.1 and 7.4).

### 1.3 Non-goals

- Generics over role types. `spawn<R>` takes a concrete role, so a shared
  cluster builder cannot live in a library (Section 10.1).
- Refinement types. Nothing in this design reads or produces them.
- Collapsing the `bin/spur/panel` variants. They differ in behavior, not in
  structure (Section 10.2).
- A package registry, versioned dependencies, a lock file, or any network
  fetch. A dependency is a relative path in `spur.json` (Section 4.3), and the
  standard library is compiled into the binary (Section 6).
- Separate compilation. A crate is a source root plus a configuration, not a
  compilation unit: every crate in the graph is resolved by one `Resolver` in
  one pass (Section 4.3).
- Renaming or module-qualifying RPC handler names and enum variant names. Both
  stay late-bound strings. A handler carries a visibility bit and nothing else
  (Sections 2.5 and 2.6).

---

## 2. Language surface

### 2.1 Grammar changes

Written as a delta to `spur/design/language.md`. Productions not listed are
unchanged.

```ebnf
program ::= use_decl* top_level_def* EOF

top_level_def ::=
  role_def
  | client_def
  | type_def_stmt
  | func_def

visibility ::= 'pub' | (* empty *)

role_def      ::= visibility 'role' ID role_param '{' var_inits func_defs '}'
client_def    ::= visibility 'client' ID role_param '{' var_inits func_defs '}'
type_def_stmt ::= visibility 'type' ID ( struct_body | enum_def | type_alias ) ';'?

(* One visibility slot per item. The same production covers a free function
   and a role or client function, so a handler is marked like anything else. *)
func_def ::= annotation* visibility ( 'async' )? 'fn' ID '(' func_params? ')' ( ':' type_def )? block

use_decl ::= visibility 'use' path ( 'as' ID )? ';'

path ::= ID ( '::' ID )*

(* An item name in a type, call, literal or pattern position is a path. *)
base_type ::=
  path
  | 'map' '<' type_def ',' type_def '>'
  | 'list' '<' type_def '>'
  | 'chan' '<' type_def '>'
  | 'FifoLink' '<' type_def '>'
  | '(' type_def_list? ')'

func_call        ::= path '(' args? ')'
struct_literal   ::= path '{' field_inits? '}'
named_dot_access ::= path '.' ID ( '(' expr ')' )?
pattern          ::= path '.' ID ( '(' pattern ')' )? | ID | '_' | '(' ')' | '(' pattern_list ')'

annotation_arg ::= ID '=' path
```

Lexer changes (`spur/spur-core/src/lexer.rs`):

- Punctuation: `':'` gains a third case. Today it produces `ColonEqual` on
  `:=` and `Colon` otherwise (`lexer.rs:587-593`); it gains `DoubleColon` on
  `::`. `TokenKind` (`lexer.rs:31`) and its `Display` arm (`lexer.rs:142`) gain
  the variant.
- Keywords table (`lexer.rs:224-266`): add `use`, `pub`, `as`.

A grep of every `.spur` file found no use of `use`, `pub` or `as` as an
identifier, and no `::` in any source position.

Parser changes (`spur/spur-core/src/parser.rs`):

- `Program` (`:30-33`) gains `uses: Vec<UseDecl>`; `TopLevelDef` variants gain
  a `vis: Visibility` field.
- A new `path_parser` replaces the bare `ident` in the five positions above.
  `ident_parser` (`:378`) stays for the positions that are genuinely single
  identifiers: variable names, field names, function parameters, variant names,
  struct-literal field names, and the alias after `as`.
- `use_decl` parses before any `top_level_def`, so imports are a header. This
  makes the loader's scan (Section 4.2) a prefix scan rather than a whole-file
  walk.

### 2.2 Paths

`::` separates module and item segments. `.` keeps every meaning it has today:
struct field access, tuple element access, enum variant selection, and the
separator between a role and its function in output strings.

Two rules make a path unambiguous without lookahead:

1. **A single-segment path in expression position is a bare name**, resolved
   exactly as today: a variable first (`resolver.rs:986`), otherwise the
   current module's own declarations and its imports.
2. **A multi-segment path is always an item path.** It never consults local
   variables.

The second rule is what keeps `NamedDotAccess` tractable. `a.b` is ambiguous
today between a variant literal and a field access, and the resolver decides it
by trying `lookup_type` first (`resolver.rs:1147-1174`). Writing module hops
with `.` would add a third reading to that same production. With `::`, the
module prefix is consumed before the ambiguity is reached: `raft::Msg.Prepare(x)`
parses as the path `raft::Msg` followed by `.Prepare(x)`, and the existing
two-way decision is unchanged.

There is no `crate::` root marker and no `super::` (Appendix A.9).

### 2.2.1 Two kinds of path

Where a path's first segment is looked up depends on where the path is
written. The distinction is small, it is the only one, and everything in
Sections 4 and 5 follows from it.

**A `use` path is crate-absolute.** Its first segment is one of exactly three
things, and the loader decides which:

1. a dependency alias of the current crate (Section 4.3),
2. `std`,
3. a **top-level module of the current crate**, that is, a file `<root>/s1.spur`.

It is never a local binding, never a sibling shorthand, and never an item. A
`use` says where something lives, in coordinates that mean the same thing in
every file of the crate.

**An inline path is binding-relative.** A path written in a type, a call, a
struct literal, a pattern or an annotation argument starts at a module **bound
in the current module** -- which is exactly what a `use` installs. An inline
path says what this file calls that thing.

```
use raft::log;          // crate-absolute: raft.spur, then log in its table
var e: log::Entry = ...;   // binding-relative: `log` is bound here by the use
```

The loader is the authority for the first rule: it resolves a `use` path's
origin from the crate manifest and the directory tree (Section 4.2), so no
import can change where another import starts. The resolver is the authority
for the second: an inline path reads the current module's `modules` map
(Section 5.5). Section 5.1 initializes the import walk from the first rule.

### 2.3 Imports

```
use raft;                       // binds the module `raft`
use raft::Node;                 // binds the item `Node`
use raft::Node as Replica;      // binds it under another name
pub use raft::Node;             // binds it, and re-exports it from this module
use std::quorum;                // the standard library is a module like any other
```

- `use path;` binds the path's last segment.
- `use path as alias;` binds `alias` instead.
- `pub use` additionally makes the binding visible to importers of this module.
- There are **no glob imports and no brace lists**. A brace list is pure sugar
  (`use a::{b, c};` desugars to two `use` declarations before any resolution
  runs) and can be added later with no effect on anything in Sections 3 to 5.
  A glob cannot (Section 3.5).

Because there are no globs, **every binding has exactly one source**, and a
name that is bound twice in one module and one namespace is always an error at
the second `use`. Ambiguity bindings -- a marker installed by two conflicting
globs and reported only when the name is used -- are therefore not needed, and
no part of this design has a "maybe ambiguous" state. If globs were added
later, three rules would have to appear: a glob-installed binding must be
shadowable by an explicit `use` or a declaration; two globs installing the same
name must install an ambiguity marker rather than error; and the fixpoint of
Section 5 must treat a glob as a dependency on the *whole* binding table of the
source module, not on one `(module, name)` key, which makes the wake list
coarser and the blocking graph less precise.

A path may be written inline wherever an item name is allowed, so `use` is only
a shorthand:

```
type ShardedKV {
    shards: list<raft::Raft>;      // needs `use raft;` in this module
    routers: list<Router>;
};
```

### 2.4 Visibility

An item is `pub` or private. There is no `pub(crate)` or `pub(super)`.

- **`pub`**: visible to any module that can name it.
- **private** (the default): visible in the declaring module and its
  descendants in the module tree.

Private-to-descendants rather than private-to-file, because a module that grows
into a directory should not have to widen anything to keep working: a helper in
`raft.spur` stays available to `raft/log.spur` with no `pub`. The reverse
direction is not covered -- a helper in `raft/log.spur` that `raft.spur` calls
does need `pub`, the same rule Rust has -- and that is the right asymmetry,
because a child is an implementation detail of its parent's subtree, not the
other way round. The mechanism costs one integer comparison (Section 3.6), so
the simpler rule would buy nothing.

Roles and clients get no exemption. A role that is used by another module is
declared `pub role Node(...)`, like a type or a function. A role's functions
carry the bit too (Section 2.6).

The rule is one function, used identically for a module hop, for a final item
and for an RPC handler (Section 3.6). Descendant-ness is tested with DFS
entry/exit intervals stamped by the loader over the crate forest
(Section 4.3).

`pub use` has one rule that must be stated exactly:

> A re-export installs a binding whose visibility is the `use` declaration's
> own. The source item's visibility is checked once, at the import site, with
> the same `check_visible`. An importer of the re-export checks the re-export's
> visibility against the re-exporting module, and does not re-check the
> original item.

So `pub use a::b::C;` in module `M` requires that `C` be visible *from M*, and
thereafter `M::C` is visible wherever `M` is. This one-hop rule is what would
make a prelude possible (Section 6). It also means a `pub use` can widen
access: a module may re-export an item that its own importers could not have
reached directly. That is the point of a re-export and is not treated as a
leak.

### 2.5 What is not module-qualified

Two classes of name stay strings checked by the checker, and are deliberately
outside the module system. This is the rule that keeps a second resolution path
from appearing.

1. **RPC handler names.** `peer->Handler(args)` is resolved against the static
   role type of `peer`, not against any scope: the checker takes
   `Type::Role(id, _)` from the target and looks `Handler` up in
   `role_func_signatures[id]` by string
   (`spur/spur-core/src/analysis/checker.rs:2398-2440`). The resolver leaves
   `ResolvedRpcCall.original_name` as a `String` (`resolver.rs:298-301`,
   `:1069-1085`). Nothing changes: once the *role* is resolved through a path,
   its handler names are already scoped by that role.
2. **Enum variant names.** `Msg.Prepare` resolves the enum through
   `lookup_type` and keeps `Prepare` as a string
   (`resolver.rs:1136-1146`, `:963-976`). The enum may be a path; the variant
   never is.

Field names, struct-literal field names, annotation keys and `set_timer`
labels are likewise unqualified strings.

Section 2.6 adds a visibility bit to a role's functions. That bit is not a
name: it changes who may call a handler, never how the handler is found.

### 2.6 Handler visibility

A role's functions are `pub` or private, like any other item:

```
pub role Node(cluster: Raft) {
    @trace
    pub async fn AppendEntries(req: AppendReq): AppendResp { ... }

    // Reachable only from this module and its descendants.
    async fn replicate_to(peer: int) { ... }
}
```

- An RPC call `peer->Handler(args)`, and the same call through a
  `FifoLink<Node>`, checks `check_visible(owner, vis, use_site)` where `owner`
  is the module that declares the handler's role and `use_site` is the module
  that contains the call.
- **The handler's name is still late-bound and still unqualified.** The bit is
  read where the checker already resolves the handler by string, immediately
  after `role_funcs.get(&call.original_name)`
  (`spur/spur-core/src/analysis/checker.rs:2430-2440`). Section 2.5's rule is
  intact: nothing about handler lookup moves into the resolver.
- **A sync helper reached through the role's own scope needs no bit.** Such a
  call goes through `lookup_func` and `role_func_scopes[current_role]`
  (`resolver.rs:477-496`), which is only reachable from inside the role, hence
  from inside the module that declares it. The bit is consulted on `->` only.
- **Runtime lookups ignore visibility.** `RoleTable::new`
  (`spur/spur-core/src/simulator/deploy.rs:40-52`) finds `BASE_NODE_INIT`,
  `Init`, `RecoverInit`, `Write`, `Read` and `RMW` by name and the simulator
  calls them whatever the bit says. Client operations and the two init
  functions are therefore public by construction, and marking them private
  changes nothing about how a run executes. The bit governs one thing: whether
  a `->` call type-checks.
- **Migration cost is zero.** Every existing spec is one file, hence one
  module, so every handler call in the tree is intra-module and
  `check_visible(M, Private, M)` is true. Not one line of any spec has to
  change (Section 9.1).

---

## 3. Static semantics

### 3.1 The module tree

Every crate has its own module tree, rooted at its own directory.

- The **root directory** is the directory holding the crate's `spur.json`,
  and the **entry spec** is the file its `root` field names (Section 4.1). A
  `.spur` file compiled on its own gets an implicit manifest whose root is that
  file, so its root directory is its parent.
- The **root module** is the entry spec itself. Its module path is empty.
- The module path `s1::s2::...::sn` names the file
  `<root>/s1/s2/.../sn.spur`. The intermediate segments are directories; the
  last is a file.
- A module's **parent** is the module named by its path minus the last segment.
  The parent of a depth-one module is the root module.

There are no inline modules and no `mod` declarations, and the manifest lists
no modules, so the tree is exactly the set of loaded files and a module's path
is a function of its file path. Only files reached by a `use` are loaded
(Section 4.2).

A module's parent need not exist as a file. `use a::b::C;` with `a/b.spur`
present and `a.spur` absent is legal: `a` is a directory, not a module. In that
case the module `a::b` has no parent module, and for the visibility interval it
is attached to its crate's root module (Section 3.6).

**The entry spec's own items cannot be imported.** A `use` path is
crate-absolute and its first segment names a module, never an item
(Section 2.2.1), so `use Foo;` for something declared in the entry spec is
`ModuleNotBound`. There is no spelling for "an item of the root module".

This is deliberate, and the rule it enforces is:

> Shared items live in a library module. The entry spec holds the deploy, the
> client, and nothing anyone else needs.

An entry spec is the one file whose identity is "this is what runs"; a file
that other modules import is a library, and a library should be named. The
alternative -- a reserved first segment for the crate root, as tygr spells
`crate::` -- is rejected in Appendix A.9. Section 9.2's example follows the
rule: `sharded.spur` declares only `ShardedKV`, `ShardParams`, `Router`,
`Sharded` and `RouterClient`, and `raft.spur` imports none of them.

### 3.2 Namespaces and per-module binding tables

The resolver has four name spaces that outlive a function body
(`resolver.rs:306-323`). Local variables (`var_scopes`) are the fifth and are
not affected by modules.

| Namespace | Today | Holds |
| --- | --- | --- |
| types | `type_scopes[0]` (`:307`) | structs, enums, aliases, and every role and client name (`declare_role`, `:443-455`, inserts into both) |
| roles | `role_scope` (`:308`) | roles and clients, used by `lookup_role` (`:510`) |
| functions | `global_func_scope` (`:313`) | free functions |
| role functions | `role_func_scopes` (`:311`), keyed by role `NameId` | a role's own functions |
| modules | -- | new |

Each of the first three plus `modules` becomes **per module**:

```rust
struct ModuleTable {
    modules: HashMap<String, Binding<ModuleId>>,
    types:   HashMap<String, Binding<NameId>>,
    roles:   HashMap<String, Binding<NameId>>,
    funcs:   HashMap<String, Binding<NameId>>,
}

struct Binding<T> {
    value: T,
    vis: Visibility,
    /// The module whose descendants a private binding is visible in: the
    /// declaring module for a declaration, the importing module for a `use`.
    owner: ModuleId,
    span: Span,
    poisoned: bool,
}
```

`role_func_scopes` stays global and keyed by role `NameId`, because a role's
functions are reached only through the role, which is already resolved. The
existing `client_func_scope` field (`:312`) is never written and is removed;
clients go through `role_func_scopes` like roles, since `declare_role`
(`:443-455`) handles both kinds.

A role's functions carry a visibility bit but no module binding of their own.
`FunctionSignature` (`spur/spur-core/src/analysis/checker.rs:211-215`) gains
`vis: Visibility` and `owner: ModuleId`, filled where the checker registers
each role function (`checker.rs:447-470`). `owner` is the module that declares
the role, so every function of a role shares it, and the RPC check of
Section 2.6 reads the two fields it already has in hand.

`type_scopes` keeps its stack shape for the four prepopulated primitive types
(`resolver.rs:350-361`), which are installed once in a synthetic bottom frame
shared by every module. A module's own `types` map sits above it.

### 3.3 Declarations and duplicates

- A declaration installs into its module's table with `owner` set to that
  module and `vis` from the `pub` prefix. A role installs into both `types` and
  `roles`, as `declare_role` does today.
- Two declarations of the same name in one module and one namespace raise
  `DuplicateName` (`resolver.rs:11`), which is the existing error, now scoped
  per module instead of per program. Two modules may each declare `Node`.
- A `use` installing a name already bound in that module and that namespace --
  whether by a declaration or by another `use`, and whichever came first --
  raises `DuplicateImport` at the `use` site. Declaration order does not
  matter, because declarations are installed before the import fixpoint runs
  (Section 5.1).

### 3.4 How `use` interacts with each namespace

The final segment of a `use` path is looked up in **all four namespaces** of
the source module, and the `use` installs a binding in every namespace where
it is bound:

| Source binding | Installs in |
| --- | --- |
| a module | `modules` |
| a struct, enum or alias | `types` |
| a role or client | `types` and `roles` |
| a free function | `funcs` |
| a role and a free function with the same name | `types`, `roles` and `funcs` |

The `use` is unresolved only when the name is bound in no namespace. It fails
with `DuplicateImport` when the target module already binds it in any one
namespace.

A submodule needs no special case. The loader installs `a/b.spur` into `a`'s
`modules` namespace (Section 4.2), so if `a.spur` also declares a type `b`, the
two sit in different namespaces and `use a::b;` installs both, by the rule
above. Nothing is ambiguous: only a module can be a path prefix, and each use
site picks the namespace its position requires.

A `use` installs the **declaration's** `NameId`, never a fresh one. An alias
changes the spelling in the importing module and nothing else: `use raft::Node
as Replica;` gives `Replica` the same `NameId`, the same `role_func_scopes`
entry, and the same qualified display name `raft::Node` in every output string.

### 3.5 Shadowing

- Locals and items are in different namespaces and do not shadow each other,
  which is already true today: a local `x` and a free function `x` coexist,
  because `lookup_var` (`:473`) and `lookup_func` (`:477`) read different maps.
  A local named `Node` does not hide the role `Node` in a type position.
- A role parameter's name still blocks a local of the same name
  (`declare_var`, `:420-431`).
- An import does not shadow a declaration in the same module; it collides with
  it (Section 3.3). This is only sound because there are no globs. With globs,
  a glob-installed binding would have to be shadowable, which introduces a
  precedence order between three binding sources.
- A multi-segment path never consults `var_scopes` (Section 2.2), so a local
  can never hide a module.

### 3.6 The visibility check

The loader stamps every module with a DFS interval over the crate forest: a
synthetic super-root whose children are the crate root modules, `enter` before
descending into children, `exit` after. Parent intervals strictly contain their
children's, and crate roots are siblings, so no crate's private items reach
another crate (Section 4.3).

```rust
fn check_visible(owner: ModuleId, vis: Visibility, use_site: ModuleId) -> bool {
    match vis {
        Visibility::Pub => true,
        Visibility::Private => {
            let o = scope[owner];
            let u = scope[use_site];
            o.enter <= u.enter && u.exit <= o.exit
        }
    }
}
```

This one function is called at every hop of a path, at the final item, and on
every RPC call. It is called with the module that **contains** the binding,
never the module being entered. For `a::b::C` resolved from module `M`:

1. `a` is bound in `M`'s `modules` map: `check_visible(M, vis_of(a in M), M)`.
   A binding in the use site's own module is trivially visible; the call is
   made anyway so there is one code path.
2. `b` is bound in module `a`'s `modules` map, with `owner == a`:
   `check_visible(a, vis_of(b in a), M)`. A module the loader installed from
   the directory tree is `pub` (Section 4.2), so this step decides something
   only when `b` was bound by a `use` in `a`.
3. `C` is bound in module `a::b`, with `owner == a::b`:
   `check_visible(a::b, vis_of(C), M)`.

Step 2 is the step that must pass the **containing** module `a`, not the module
being entered `a::b`. Passing the child makes a private child module
unreachable from its own parent, which is exactly backwards
(Appendix B, defect 3).

A binding installed by `use` carries `owner = the importing module`, so a
private `use` in module `M` is visible in `M` and its descendants, and a
`pub use` is visible everywhere `M` is. That is the rule of Section 2.4 falling
out of the same function.

A module whose parent file does not exist (Section 3.1) is stamped as a child
of its crate's root module, so a private item in it is visible only inside it.

The fourth call site is the RPC check of Section 2.6:
`check_visible(sig.owner, sig.vis, caller_module)`, where `sig` is the
`FunctionSignature` the checker has just looked up by name
(`checker.rs:2430-2440`). It is the same function with the same argument order
and the same meaning of `owner`: the module that declares the handler's role.

### 3.7 Identity

`Resolver::next_id` (`resolver.rs:387-393`) stays the single program-wide
counter. Every name in every module, and every local in every function body,
mints from it.

- There is no per-module or per-crate component in `NameId`.
- There is one `Resolver` per program, so there is one counter, used by exactly
  one pass. Locals are minted by the same `new_name_id` as top-level
  declarations, from the same `self`.
- A crate boundary mints nothing and re-interns nothing. Every crate in the
  graph is declared and resolved in the same pass by the same `Resolver`
  (Section 4.3), so a dependency's items sit in the same id space as the root
  crate's.
- `ResolvedProgram.id_to_name` (`resolver.rs:19`) gains the **qualified**
  spelling as the value (Section 7.1). A second map,
  `module_of: HashMap<NameId, ModuleId>`, records where each name was declared,
  for diagnostics that want the short form.

The counter constraint is not cosmetic. `Type::Struct(NameId, String)`,
`Type::Enum(NameId, String)` and `Type::Role(NameId, String)`
(`spur/spur-ast/src/types.rs:17-19`) derive `PartialEq` over **both** fields
(`types.rs:9`), and that equality is load-bearing: the deploy check compares
`client.param.ty != root` by structural equality
(`spur/spur-core/src/analysis/checker/topology.rs:159`). Two consequences:

1. The display string must be a pure function of the `NameId`. Neither an
   import alias nor a dependency alias may change it (Sections 3.4 and 7.1).
2. Two identical type declarations in two modules are two `NameId`s and
   therefore two distinct types. There is no structural merging.

### 3.8 Annotation arguments that name items

`@deploy(client = KVClient)` is resolved today by string comparison in the
checker: `role_defs.iter().find(|r| r.kind == RoleKind::Client && r.original_name
== client_args[0].1)` (`checker/topology.rs:154`). `Annotation.args` is
`Vec<(String, String)>` (`spur/spur-ast/src/types.rs:385-389`), so the value is
an unresolved string all the way to the checker.

With modules, `@deploy(client = sharded::RouterClient)` cannot be matched
against `original_name`. The resolution moves to the resolver:

- The grammar's `annotation_arg` takes a `path` (Section 2.1).
- A new `ResolvedAnnotation { name: String, args: Vec<(String, AnnotationArg)> }`
  with `AnnotationArg::Item(NameId, String)` carries the resolved id and its
  qualified spelling. The resolver resolves the path in the `roles` namespace
  of the annotated function's module and emits `NameNotFound` on failure.
- `checker/topology.rs:154` compares `client.name == id`.

`@trace`, `@scale`, `@choice` and `@quorum` take no path arguments and are
unchanged. They are keyed by `NameId` in `TopologyMetadata.tags`
(`types.rs:429`), and `NameId`s are program-wide, so **tags survive import with
no work at all**.

### 3.9 Error catalog

New `ResolutionError` variants, added next to `NameNotFound` and
`DuplicateName` (`resolver.rs:7-13`). Loader failures are `ResolutionError`s so
that every diagnostic flows through one accumulation path (Section 5.4) and one
LSP mapping.

| Variant | Blamed on | Message |
| --- | --- | --- |
| `ModuleFileMissing { path, file, span }` | the `use` site | `no module `a::b`: expected file `a/b.spur`` |
| `UnresolvedImport { path, segment, span }` | the `use` site | `cannot resolve `C` in `a::b`` |
| `NotAModule { path, segment, span }` | the `use` site | `` `b` is an item, not a module`` |
| `ModuleNotBound { segment, span, kind }` | the path's first segment | for a `use` path, `` `Foo` is not a module of this crate or a dependency ``; for an inline path, `` `raft` is not a module in this file; add `use raft;` ``. The two kinds of path start in different places (Section 2.2.1), so they need different advice |
| `DuplicateImport { name, first, span }` | the second `use` | `` `Node` is already bound in this file `` |
| `PrivateItem { path, segment, declared_in, span }` | the `use` or path site | `` `Node` is private to `raft` `` |
| `ImportCycle { members: Vec<(String, Span)> }` | every member | `these imports depend on each other` |
| `SelfImport { span }` | the `use` site | `a file cannot import itself` |
| `DuplicateModule { file, first_path, path, span }` | the second `use` site | `two module paths reach `a/b.spur`` |
| `ModuleTooDeep { path, span }` | the `use` site | `module path exceeds the depth limit` |
| `TooManyModules { span }` | the `use` site | `program loads more than 1024 modules` |

One new `TypeError` variant, because handler visibility is checked where the
handler is resolved:

| Variant | Blamed on | Message |
| --- | --- | --- |
| `PrivateHandler { func_name, role, declared_in, span }` | the `->` call | `` handler `AppendEntries` of `raft::Node` is private to `raft` `` |

Manifest failures are `ManifestError`s with their own table in Section 4.1.

LSP mapping: each `ResolutionError` variant gets an arm in
`resolution_error_to_diagnostic` (`spur/spur-lsp/src/diagnostics.rs:134-146`);
`PrivateHandler` gets one in `type_error_to_diagnostic` (`:148`), next to
`RpcCallTargetNotRole` (`:211`); `ManifestError` gets a third converter
publishing to the `spur.json` URI. All are `DiagnosticSeverity::ERROR` with
source `"spur"`. The difference from today is routing rather than severity: a
diagnostic's URI is now the file named by `span.context`, not the buffer that
triggered the compile (Section 8.1).

`ImportCycle` is reported once per strongly connected component, with one
diagnostic per member so that every file involved shows the problem.

---

## 4. Crates and loading

### 4.1 The crate manifest

A **crate** is a source root plus a configuration file. The file is
`spur.json`, and it sits at the crate's root directory.

```json
{
  "name": "raft",
  "root": "src/raft.spur",
  "deps": {
    "paxos": { "path": "../paxos" }
  },
  "presets": {
    "debug":  { "config": "configs/raft_debug.json", "deploy": "Single",
                "set": ["num_runs_per_config=10"] },
    "oracle": { "plan": "plans/leader_churn.json" }
  }
}
```

JSON, not TOML: the workspace has no `toml` dependency and reads every
configuration it owns with `serde_json` (`spur/spur-cli/Cargo.toml:26`,
`spur/spur-core/Cargo.toml:38`), and the research harness already parses JSON
for every config it materializes.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | the manifest directory's name | The crate's name. It must match the grammar's `ID`. It prefixes the display names of this crate's items when the crate is a dependency (Section 7.1) |
| `root` | string | required | The entry spec, relative to the manifest directory. Must end in `.spur` and must exist |
| `deps` | object | `{}` | Alias to `{ "path": ... }`, relative to the manifest directory (Section 4.3) |
| `presets` | object | `{}` | Named CLI invocations (Section 8.2) |

A preset carries `config` **or** `plan`, never both, plus optional `deploy`,
`set` (an array of `path=value` assignments) and `output_dir`. Its paths are
relative to the manifest directory.

Presets live here rather than in a file of their own because a preset names a
config, a plan and a deploy, all of which are properties of the crate; a second
file would be a second thing to find and a second parse to fail. Revisit if a
machine ever generates them, since a generated file should not share a document
with a hand-edited `deps`.

The filename is `spur.json`: lowercase, so it sorts beside the `.spur` files it
governs and matches every other path in this repository; not hidden, so `ls`
shows it; and with an extension that tells a reader and an editor what is
inside.

Unknown fields are rejected, so a typo in `presets` is an error rather than a
silently ignored key.

Load-time errors, each carrying a span into the registered `spur.json`
(Section 4.5):

| Error | Cause |
| --- | --- |
| `ManifestParse` | not valid JSON, or an unknown field |
| `ManifestMissingRoot` | no `root` |
| `ManifestRootMissing` | `root` names a file that does not exist, or does not end in `.spur` |
| `ManifestBadName` | `name` is not an `ID` |
| `ManifestBadAlias` | a dependency alias is not an `ID` |
| `ManifestReservedAlias` | a dependency is aliased `std` |
| `ManifestDepMissing` | a dependency path has no `spur.json` |
| `ManifestDepCycle` | the crate graph has a cycle, listing its members |
| `PresetUnknown` | `--preset` names a preset the manifest does not define |
| `PresetConfigAndPlan` | a preset sets both `config` and `plan` |

These are `ManifestError`s, collected in `CompileResult.manifest_errors`. They
are not `ResolutionError`s: they happen before any token exists, and reporting
a JSON syntax error as a name-resolution failure would be a lie. They still
carry real spans and render through the same source map and the same ariadne
path as everything else (Section 4.7).

**The manifest never lists modules.** There is no `mod`, no module list, no
`include` and no `exclude`. The directory tree is the module tree
(Section 3.1); the manifest says only where that tree starts, what other trees
are reachable, and what a convenient invocation looks like.

**The implicit manifest.** Several callers have a `.spur` file and no crate:

- `spur explore bin/spur/Raft.spur ...` and every other CLI subcommand given a
  bare `.spur` path
- `compile_source(text, name)` -- tests, fixtures, `spur-bench`
  (`spur/spur-bench/src/lib.rs`)
- an LSP buffer with no `spur.json` above it (Section 8.1)

Each gets an in-memory manifest: `root` is that file, the root directory is its
parent, `name` is the file stem, `deps` is empty and `presets` is empty. **No
`spur.json` is read, written or required.** Every spec under `bin/spur` and
every fixture therefore compiles exactly as it does today, and the
empty-migration property of Section 9.1 holds without qualification: a
one-file spec is a one-crate, one-module program whose root crate contributes
no prefix and whose root module path is empty.

When the CLI is given a directory, or a `spur.json`, it reads that manifest and
compiles its `root`. When it is given a `.spur` path, that file is the entry
and the implicit manifest applies, **whether or not a `spur.json` sits beside
it**. `spur check bin/spur/Raft.spur` compiles `Raft.spur`, even once
`bin/spur/spur.json` exists to govern the sharded example: a crate's manifest
does not capture every `.spur` file under it, only the ones its root reaches.
Naming an entry explicitly is what a command line is for.

### 4.2 File discovery

Loading is a phase of its own, before any name resolution. It needs no
resolution because `use` paths are syntactic. It starts at the root crate's
manifest and follows `use` declarations and dependency aliases.

```
load(manifest_path):
    crates = {}                                     # canonical manifest path -> Crate
    queue  = [manifest_path]
    while queue is non-empty:
        mp = canonicalize(queue.pop())
        if mp in crates: continue                   # diamonds load once
        man = read_manifest(mp)                     # Section 4.1
        crates[mp] = load_crate(man)
        queue.extend(dir + "/spur.json" for dir in man.deps.values())
    reject_crate_cycles(crates)                     # ManifestDepCycle
    stamp_dfs_intervals(crates)                     # one forest walk, Section 4.3

load_crate(man):
    root_dir = parent(man.path)
    root = parse_file(root_dir / man.root, module_path = [])
    queue = [(u, root) for u in root.uses]
    while queue is non-empty:
        (u, from_module) = queue.pop()
        (crate, mp) = target_of(u, from_module)     # see below
        if crate is not this crate: continue        # loaded with that crate
        if mp is already loaded: continue
        m = parse_file(root_dir / mp.join("/") + ".spur", mp)
        queue.extend((v, m) for v in m.uses)
```

`target_of(u, m)` for a `use` path with segments `s1..sn`, resolved against the
crate that contains `m`. `use` paths are crate-absolute (Section 2.2.1), so `m`
affects only which crate is meant, never where the walk starts.

**Origin, from `s1` alone:**

- `s1` is a dependency alias of that crate, or `std`: the origin is that other
  crate's root module, and the rest of the path is resolved against **its**
  root directory. `s1` contributes no file of its own.
- `s1` names a top-level module of this crate, that is `<root>/s1.spur` exists:
  the origin is that module.
- Otherwise: `ModuleNotBound`. In particular a bare `use Foo;` naming an item
  of the entry spec is rejected here (Section 3.1).

**The rest of the path,** with `<root>` the origin crate's root directory:

- If `<root>/s1/.../sn.spur` exists, the path names a module; the module path
  is `s1..sn` and the `use` binds a module.
- Otherwise `<root>/s1/.../s(n-1).spur` must exist; the module path is
  `s1..s(n-1)` and `sn` is an item or a binding installed by a `use` in that
  module.
- A segment that is neither may still be a module re-exported into the previous
  module by a `pub use`. The loader stops there and hands the remaining
  segments to the fixpoint, which walks them through `ModuleTable`s
  (Section 5.1).
- If a segment has no file and no module that could bind it, the loader reports
  `ModuleFileMissing`, naming the first segment `si` for which
  `<root>/s1/.../si` is neither a directory nor a file. Blame is on the `use`
  site's span, which carries the importing file's `SourceId`, so the diagnostic
  lands in the right buffer.
- A path that resolves to the importing module itself: `SelfImport`. A module
  cycle is legal (Section 4.4) because each side's import adds a name the other
  side does not have; a self-import can add nothing, since every name in the
  module is already in scope there, so it is always a mistake.

**Modules are installed into their parents.** As the loader loads a module it
installs it in its parent's `modules` namespace as a **`pub` binding**, so a
`use` path's walk has a chain to follow from its origin. There is no syntax for
a private module and there is none by inference: a file in the tree is
reachable by path from anywhere in its crate, and privacy is a property of
items (Section 2.4). What a `pub use` of a module adds is a second, shorter
spelling, not access.

Only files reached this way are loaded. A `.spur` file in the tree that nothing
imports is never read, never parsed, and never contributes a diagnostic.

Because `use` declarations are a header (Section 2.1), the loader could stop
parsing after them; it does not, because the full AST is needed anyway and
parsing twice costs more than parsing once.

### 4.3 Dependencies and the crate graph

`deps` maps an alias to a directory holding another `spur.json`. There is no
registry, no version, no lock file and no network access. A dependency is a
path or it does not exist.

A version is only meaningful against a registry to resolve it, and a registry
is a subsystem of its own: fetching, caching, integrity, offline behavior, and
a reproducibility story for recorded runs. A `version` field without one would
be documentation the compiler cannot check, which is worse than nothing. If
sharing protocols across repositories ever matters, the answer is a git
submodule and a relative path, which is what this repository already does for
`spur` itself.

- **The alias is a module binding.** Each alias is pre-installed in the
  `modules` namespace of every module of the depending crate, bound to the
  dependency's root module. `std` is the same mechanism with an embedded source
  (Section 6). So `paxos::Node` names an item in the dependency's root module,
  and `paxos::log::Entry` names one in `<dep root dir>/log.spur`.
- **An alias is a spelling, never a name.** The qualified display name of an
  imported item derives from the **defining** crate's manifest `name`, not from
  the alias the importer chose. This is a hard constraint, because a display
  name must be a pure function of the `NameId` (Sections 3.7 and 7.1): one
  crate reached under two aliases must still produce one `Type::Role` value, or
  a deploy's root type stops matching its client's parameter.
- **Aliases are not transitive.** A dependency's own dependencies are bound
  only inside it. A crate reaches them only through a `pub use`.
- **Crates dedupe by canonicalized manifest path.** A diamond -- two
  dependencies that both depend on a third -- loads and compiles that third
  crate once, and its items have one `NameId` each. Two aliases for one crate
  are two spellings of the same bindings.
- **Crate cycles are rejected**, with `ManifestDepCycle` naming every member.
  Module cycles inside a crate stay legal (Section 4.4); a crate cycle is
  rejected because the crate graph also orders nothing else, so a cycle in it
  is always a mistake rather than a shape to support.

**One resolver, one counter, no compilation unit.** Every crate in the graph is
loaded into the same `SourceMap` and resolved by the same `Resolver`, with the
same program-wide `NameId` counter (Section 3.7). A crate is a source root and
a configuration, not a compilation unit:

- there is no separate compilation and no per-crate cache;
- no name is re-interned at a crate boundary, and no id carries a crate
  component;
- there is exactly one `next_id`, used for declarations in every crate and for
  locals in every body.

This is what makes tygr's second defect structurally impossible rather than
merely absent (Appendix B.2.2): that defect exists because a per-crate context
and a fresh body-pass context mint from two counters into one id space. Here
there is one counter and nothing to default-construct.

**Visibility across crates.** The DFS intervals of Section 3.6 are stamped over
a *forest*: a synthetic super-root whose children are the crate root modules,
walked in load order. Crate roots are therefore siblings, so a private item in
one crate is never visible in another, and the root crate's private items are
not visible in its dependencies. The comparison in `check_visible` is
unchanged.

### 4.4 Duplicate modules, depth, and cycles

- **Duplicate module.** Module paths are canonicalized with
  `std::fs::canonicalize` before insertion. Two distinct module paths that
  canonicalize to the same file -- reachable only through a symlinked directory
  -- raise `DuplicateModule`. They must be an error rather than a
  deduplication, because the file's items would otherwise have two qualified
  names and two positions in the visibility tree.
- **Depth limit.** A module path may have at most 32 segments, and a program
  may load at most 1024 modules. Both raise an error naming the `use` site.
  Module paths cannot be cyclic by construction, since each segment descends
  one directory level; the caps exist to turn a symlink loop (`a -> .`) into a
  diagnostic instead of a hang.
- **Module cycles are allowed.** `a.spur` may `use b;` while `b.spur` uses
  `a;`. The loader deduplicates by module path, so the second visit is a
  no-op. Nothing about a cycle is a problem, because a module is only a
  namespace: its bodies reference each other and its declarations are installed
  before any body is resolved (Section 5.1). Spur has no module initializer and
  no top-level evaluation order, so there is nothing for a cycle to make
  ill-defined.
  - The one cycle that *is* an error is a `pub use` cycle, where module `a`
    re-exports a name that module `b` re-exports back. That is `ImportCycle`,
    detected by the fixpoint (Section 5.3), not by the loader.

### 4.5 The source map

```rust
pub struct SourceId(pub u32);
pub struct CrateId(pub u32);       // an index into SourceMap.crates, not part of any NameId

pub struct SourceFile {
    pub id: SourceId,
    pub path: PathBuf,             // absolute, canonicalized
    pub display: String,           // unique across the map; see the invariant below
    pub krate: CrateId,
    pub module_path: Vec<String>,  // empty for a crate's root module
    pub text: String,
    pub lines: LineIndex,          // spur-lsp's LineIndex, moved into core
}

pub struct CrateInfo {
    pub name: String,              // the manifest `name`
    pub root_dir: PathBuf,
    pub manifest: Option<SourceId>,// the registered spur.json, None when implicit
    pub is_root: bool,
}

pub struct SourceMap {
    files:  Vec<SourceFile>,       // index == SourceId.0
    crates: Vec<CrateInfo>,        // index == CrateId.0, 0 is the root crate
}
```

`CrateId` exists so a diagnostic can say which crate a file belongs to and so
`qualified()` can find the defining crate name (Section 7.1). It is not part
of any `NameId` and never reaches the resolver's counter (Section 4.3).

**Invariant: `display` is unique across the map.** It is not a formatting
choice. ariadne keys its source set by this string (Section 4.7), so two files
sharing one `display` means one file's labels render against the other file's
text -- silently, with plausible-looking output. Two crates each holding
`src/log.spur` is an ordinary shape, so the path relative to a crate root is
not enough on its own. The spelling:

| File | `display` |
| --- | --- |
| root crate | path relative to the root directory: `raft.spur`, `deep/inner.spur` |
| any other crate | the defining crate's `name`, a colon, then that path: `paxos:log.spur` |
| standard library | `std:quorum.spur` |
| manifest | `spur.json`, or `paxos:spur.json` |

A single colon reads as a location rather than a path segment, and it cannot be
confused with the `::` of a qualified name. The uniqueness of the whole string
follows from crate names being unique in the graph, which deduplication by
canonical manifest path guarantees (Section 4.3).

Every `spur.json` is registered in the map as a file of its own, so a manifest
error carries a real span and renders through the same path as a type error
(Section 4.7).

Reserved ids:

| Id | Meaning |
| --- | --- |
| `SourceId(0)` | synthetic. Prepopulated types (`resolver.rs:350-361`), compiler-generated spans, and `compile_source` inputs that have no file |
| `SourceId(1..=K)` | the embedded standard library, one per file (Section 6) |
| `SourceId(K+1..)` | manifests and user files, in load order |

`LineIndex` (`spur/spur-lsp/src/convert.rs:4-23`) moves into `spur-core` so the
source map owns one per file. The LSP keeps using it through the map.

### 4.6 Spans carry a file id

```rust
// spur/spur-ast/src/span.rs
pub type Span = SimpleSpan<usize, SourceId>;
```

chumsky's `SimpleSpan<Offset, Context>` threads the context through every span
the parser produces, so almost nothing in the parser changes.

**Lexer** (`spur/spur-core/src/lexer.rs`): `Lexer::new(input)` (`:325`) becomes
`Lexer::new(source_id, input)` and stores the id. The 19 `Span { .. }` struct
literals in the tree (4 of them in the lexer, at `:388`, `:445`, `:465`,
`:500`) gain a `context` field.

**Parser** (`spur/spur-core/src/parser.rs`): the edit is narrow because every
span in the AST comes from `e.span()` in a `map_with` closure, which chumsky
fills from the input's span type.

- 14 where-clause bounds spelled `I: BorrowInput<'a, Token = TokenKind, Span =
  SimpleSpan> + Clone` become `Span = spur_ast::Span`. These are the only 14
  occurrences of that text in the crate.
- `make_input` (`:1446-1451`) and `parse_program` (`:1453-1458`) take a
  `SourceId` and build the end-of-input span with it.

That is the whole parser edit: about twenty lines, no production changed for
the sake of spans. The grammar changes of Section 2.1 are separate and larger.

`ParseError.span` (`parser.rs:11-14`) and the `Rich` errors it is built from
carry the context automatically, because `e.span()` returns the input's span
type.

### 4.7 Reporting

Diagnostics are rendered with ariadne. Today every call passes a single
`filename: &str` as both the report id and the label id, and prints with
`.eprint((filename, Source::from(source)))`:
`spur/spur-core/src/analysis/format.rs:18-30` and 44 more sites in that file,
`spur/spur-core/src/parser/format.rs:12-20` and `:36-44`,
`spur/spur-core/src/lexer/format.rs:16-24` and `:26-37`.

The change is mechanical and uniform:

```rust
// One helper in analysis/format.rs, used by every site.
fn at(map: &SourceMap, span: Span) -> (&str, std::ops::Range<usize>) {
    (map.display(span.context), span.start..span.end)
}

Report::build(ReportKind::Error, at(map, *span))
    .with_message(...)
    .with_label(Label::new(at(map, *span)).with_message(...).with_color(Color::Red))
    .finish()
    .eprint(ariadne::sources(map.iter().map(|f| (f.display.as_str(), f.text.as_str()))))?;
```

`ariadne::sources` takes the whole map, so a report may label spans in several
files at once. That is what `ImportCycle` and `DuplicateImport` need: one report
with a label in each participating file.

Counts: 45 `Report::build` sites in `analysis/format.rs`, 2 in
`parser/format.rs`, 2 in `lexer/format.rs`. Each is a one-line edit. The three
`report_*` functions change signature from `(source: &str, errors, filename:
&str)` to `(map: &SourceMap, errors)`.

`parser/format.rs` renders parse and validation diagnostics. There is no source
reformatter in the tree, so no reformatting work exists in this change.

---

## 5. Import resolution

Declarations are installed into their module's `ModuleTable` first, in one
sweep over every loaded module. Imports then resolve as a worklist fixpoint
over **one mutable module tree**. There is no snapshot, no per-pass clone, and
no separate "world" that bodies read from.

The fixpoint is needed because a `use` may name a `pub use` in another module,
whose own target may be a `pub use` in a third, and so on. Only `pub use`
chains create this dependency; a `use` that names a declaration resolves on its
first pop.

### 5.1 Algorithm

```
# state
ready    : deque<UseId>                      # every use, in (module, source order)
parked   : map<(ModuleId, String), Vec<UseId>>
walk     : map<UseId, (ModuleId, usize)>     # resume point: module, next segment
errors   : Vec<ResolutionError>

for m in modules:                            # declarations first, one sweep
    install_declarations(m)

# A `use` path is crate-absolute, so its walk starts at the module its first
# segment names, not at the importing module (Section 2.2.1).
for u in all_uses:
    match origin(u):
        Ok(m) -> walk[u] = (m, 1); ready.push_back(u)
        Err(e) -> errors.push(e); install_poison(u.module, u.bound_name)

origin(u):                                   # decided by the loader, Section 4.2
    if u.path[0] is a dependency alias of u.crate: return root_module_of(that crate)
    if u.path[0] == "std":                         return root_module_of(std)
    if u.path[0] names a top-level module of u.crate: return that module
    return Err(ModuleNotBound(u.path[0], u.span))

while let Some(u) = ready.pop_front():
    match step(u):                           # resumes at walk[u]
        Advanced(module, index):
            walk[u] = (module, index)
            ready.push_back(u)
        Installed(bindings):
            for (ns, name, b) in bindings:
                install(u.module, ns, name, b)
            for w in parked.remove((u.module, u.bound_name)) or []:
                ready.push_back(w)
        Blocked(m, name):
            parked[(m, name)].push(u)
        Failed(e):
            errors.push(e)
            install_poison(u.module, u.bound_name)       # all four namespaces
            for w in parked.remove((u.module, u.bound_name)) or []:
                ready.push_back(w)

# ready is empty: everything still in `parked` is stuck (Section 5.3)
```

`step(u)` reads `walk[u] = (m, i)`, looks the segment `path[i]` up in `m`'s
table, and returns:

- `Installed` when `i == n`, the single-segment case: the origin module *is*
  the binding, and the `use` binds that module. No table is consulted;
- `Advanced` when the segment names a module and `i + 1 < n`;
- `Installed` when `i + 1 == n` and the segment is bound in at least one
  namespace, after `check_visible` passes at every hop and at the item;
- `Blocked(m, path[i])` when the segment is not bound in `m` **and** some `use`
  in `m` could still install it;
- `Failed` otherwise: no binding, no pending `use` that could produce one, a
  failed `check_visible`, a duplicate, or a hop through an item.

`Blocked` and `Failed` are distinguished by a precomputed set, built once from
the parsed `use` declarations: `could_install: map<ModuleId, HashSet<String>>`,
holding every name any `use` in that module might bind. A name absent from both
the declarations and `could_install[m]` is terminally missing and fails
immediately, without ever parking.

### 5.2 Termination and complexity

Let `U` be the number of `use` declarations and `L` the maximum path length
(bounded by 32, Section 4.4).

**Termination.** Every pop of `u` either:

- advances `walk[u]` by one segment, which can happen at most `L` times; or
- finishes `u` (`Installed` or `Failed`), which happens at most once; or
- parks `u`, which does not re-enqueue it.

A parked `u` is re-enqueued only when `(m, name)` is installed. A given
`(m, name)` key changes state at most twice: from unbound to poisoned, and from
poisoned to a real binding (Section 5.4). A third install is a
`DuplicateImport` failure and wakes nothing. Therefore `u` is woken on any one
key at most twice, parks at most `L` times in total (once per segment), and is
popped at most `3L + 1` times. The loop terminates.

**Complexity.** `O(U * L)` steps, each a constant number of hash lookups, plus
`O(U * L)` wake-list entries. The origin lookup is `O(1)` per `use`, against
tables the loader already built, so no part of a module prefix is rediscovered
here. Memory is `O(U * L)` for the parked map and `O(U)` for the walk map.
Nothing is cloned: `install` mutates the one `ModuleTable` for the target
module.

For the scale this repository works at -- tens of modules, tens of imports --
the fixpoint runs in a single pass over `ready` in the overwhelmingly common
case, because `pub use` chains are rare.

### 5.3 Diagnosing a stuck set

When `ready` empties, the uses still in `parked` are exactly the unresolved
ones. The wake edges are the blocking graph:

- Node: a parked `use`.
- Edge `u -> v`: `u` is parked on `(m, name)` and `v` is a `use` in module `m`
  whose bound name is `name`.

Every parked `u` has at least one outgoing edge, because a name with no
possible producer fails rather than parking (Section 5.1). A finite graph in
which every node has an out-edge contains a cycle, so the stuck set is a union
of strongly connected components plus the uses that reach them.

- For each SCC with more than one member, or a self-loop, report `ImportCycle`
  with every member's module path, `use` path and span.
- For a `use` that is not in an SCC but reaches one, report `ImportCycle` for
  the component it depends on; the member list makes the cause visible without
  a second error class.
- `UnresolvedImport` is the report for a `use` whose failing segment is
  terminally missing, and it is emitted directly by `Failed` rather than at the
  end.

The blocking graph is built from `parked` and `walk`, both of which are already
in hand, so the diagnosis costs `O(U * L)` and runs only when something is
stuck.

### 5.4 Poison bindings and error accumulation

Error accumulation into `Vec<ResolutionError>` (`resolver.rs:321`,
`:394-396`) stays. Nothing in this design fails fast, so a file with three bad
imports reports three diagnostics.

A failed `use` installs a **poison binding** under the name it would have
bound, in every namespace, with `poisoned: true`. Lookups that hit a poison
binding return a distinguished "already reported" result: the resolver
substitutes `ResolvedExprKind::Error` or `ResolvedTypeDef::Error`
(`resolver.rs:130`) and emits nothing. One broken import therefore produces one
diagnostic, not one per use site, and the checker still sees a well-formed tree
with `Type::Error` in the right places -- which it already unifies with
anything (`spur/spur-ast/src/types.rs:32`).

**A poison binding is not an occupant.** It satisfies lookups but does not
count for the duplicate check of Section 3.3: a later `use` or declaration of
the same name installs over it and clears the poison, with no
`DuplicateImport`. Without this rule one broken import would convert every
later, correct import of that name into a second error, which is the cascade
poison exists to prevent. A key therefore changes state at most twice, unbound
to poisoned to bound, which is what Section 5.2's pop bound counts. A third
install is a genuine duplicate and is reported as one.

### 5.5 Bodies

After the fixpoint, bodies resolve against the same mutable module tree that
the fixpoint just finished filling. There is no republish step and no second
structure, so an import installed by the last action of the fixpoint is visible
to the first body resolved. This is the single most important structural
property of Section 5 (Appendix B, defect 1).

Body resolution walks modules in load order. Within a body, name lookup is:

1. single-segment, expression position: `var_scopes`, then the current module's
   `funcs`, then -- for a call inside a role -- `role_func_scopes[current_role]`
   (`lookup_func`, `resolver.rs:477-496`, now consulting the current module's
   `funcs` instead of the one `global_func_scope`);
2. single-segment, type position: the current module's `types`, then its
   `roles` (`lookup_type`, `:498-508`, keeping its existing fallback);
3. multi-segment: an inline path, so it is binding-relative (Section 2.2.1).
   Walk it from the current module's `modules` map, calling `check_visible` at
   every hop (Section 3.6), then look the final segment up in the namespace the
   position requires. A first segment that is not a module bound here is
   `ModuleNotBound`, with the fix named in the message: add a `use`.

---

## 6. Standard library

The standard library is compiled into the binary.

```rust
// spur/spur-core/src/stdlib.rs
pub static STD_MODULES: &[(&[&str], &str)] = &[
    (&["std"],           include_str!("stdlib/std.spur")),
    (&["std", "quorum"], include_str!("stdlib/quorum.spur")),
    (&["std", "list"],   include_str!("stdlib/list.spur")),
    (&["std", "map"],    include_str!("stdlib/map.spur")),
    (&["std", "route"],  include_str!("stdlib/route.spur")),
    (&["std", "retry"],  include_str!("stdlib/retry.spur")),
];
```

- `std` is pre-installed in every module's `modules` namespace, the way the
  four primitive type names are pre-installed in the type scope
  (`resolver.rs:350-361`). No `use` is needed to write `std::quorum::f(n)`,
  and `use std::quorum;` is available as a shorthand.
- Standard library modules resolve against `STD_MODULES` instead of the
  filesystem. They get reserved `SourceId`s (Section 4.5), so a diagnostic in
  library code renders with the library text under the display name
  `std:quorum.spur` (Section 4.5).
- `std` is not a crate in `deps` and is not listed in any `spur.json`. It is
  bound by the compiler, the same way in every crate of the graph, including
  crates reached as dependencies.
- There is no install path, no `--std-path` flag and no environment variable.
  A directory shipped beside the binary would need an install path, an
  environment variable, a fallback and a version check, and a recorded run
  would stop reproducing when that directory changed under it. Embedding costs
  a rebuild to change the library, which is the right trade for a few hundred
  lines of arithmetic.
- `std` is reserved: a `<root>/std.spur` is rejected with `DuplicateModule`,
  and a dependency aliased `std` with `ManifestReservedAlias` (Section 4.1).
- **There is no prelude.** Pre-binding `std` is enough: `std::quorum::f(n)` is
  short, and every name in it is findable by reading the path. A prelude would
  put names in scope that no line of the file mentions, which is the kind of
  hidden state this design removes elsewhere. `pub use` is the mechanism that
  would make one possible later (Section 2.4), so nothing here forecloses it;
  revisit if the library grows past a handful of modules.

### 6.1 What the library can hold

Without generics over role types (Section 10.1), the library holds only code
whose types are primitives and collections of primitives.

| Module | Contents |
| --- | --- |
| `std::quorum` | `f(n)`, `majority(n)`, `is_majority(count, n)`, `super_majority(n)`, `fast_quorum(n, f)` -- the arithmetic every spec under `bin/spur` recomputes inline, e.g. `(len(cluster.nodes) - 1) / 2` |
| `std::list` | `contains_int`, `sum`, `max_int`, `range(n)`, `take`, `drop`, `last`, `unique_ints`, `prefix_eq`, `longest_common_prefix` over `list<int>` |
| `std::map` | `get_or(m, k, d)`, `increment(m, k)`, `count_true`, `keys_sorted`, `merge` over `map<string, int>` and `map<int, int>` |
| `std::route` | `shard_of(routes, key)` and `key_routes(shards, keys)` -- key routing over `map<string, int>` |
| `std::retry` | index-level retry helpers: `next_target(n, tried)`, `LeaderHint { is_leader: bool; leader: int; }` and its accessors |

`std::retry` is deliberately index-level. A retry-to-leader loop mentions a
concrete role handle and a concrete response type:

```
for ;; {
    var resp: ClientResponse = <- target->Write(key, uid);
    if (resp.is_leader) { return (); }
    target = resp.leader;
}
```

`target: Node` and `resp: ClientResponse` are protocol types, so this loop
cannot live in `std`. It can live in the protocol's own module and be shared by
every client and router that talks to that protocol, which is the reuse that
actually matters: the specs under `bin/spur` each carry their own copy of this loop today,
and after this change each protocol family carries one.

Every list and map helper is monomorphic in its element type, so
`std::list::contains_int` and a hypothetical `contains_string` are separate
functions. That is the cost of no generics, and it caps how large the library
usefully gets. Adding generics later is the way out (Section 10.1).

---

## 7. Compiled program and downstream surfaces

### 7.1 Qualified display names

Every item gets one qualified display name, computed once from where it is
**declared**:

```
qualified(item) = join("::", crate_prefix(item) + module_path(item) + [short_name])

crate_prefix(item) = []                              if item is in the root crate
                   = [defining_crate.manifest.name]  otherwise
```

Two properties do the work.

**The root crate contributes no prefix and the root module's path is empty.** A
one-file spec is a one-crate, one-module program, so its names are
byte-identical to today's. This is what makes the migration of Section 9.1
empty.

**The prefix comes from the defining crate's manifest `name`, never from the
importing alias.** This is a hard constraint, not a preference. A display name
must be a pure function of the `NameId` (Section 3.7), because
`Type::Struct(NameId, String)` and its siblings derive `PartialEq` over both
fields and that equality decides whether a deploy's root type matches its
client's parameter (`checker/topology.rs:159`). If the alias supplied the
prefix, a crate imported once as `paxos` and once as `p` would give one
`NameId` two display strings, two unequal `Type::Role` values, and a deploy
that type-checks or not depending on which alias the file happened to use.

With `"deps": { "p": { "path": "../paxos" } }` and the dependency's manifest
naming it `paxos`:

| Written in source | Display name everywhere else |
| --- | --- |
| `p::Node` | `paxos::Node` |
| `p::log::Entry` | `paxos::log::Entry` |
| `p::Node.AppendEntries` in a plan config | `paxos::Node.AppendEntries` |

The same rule covers import aliases: `use raft::Node as Replica;` leaves the
display name `raft::Node` (Section 3.4). A spelling is local to a file; a name
is global to a program.

The display name is stored in:

- `ResolvedProgram.id_to_name` (`resolver.rs:19`) and, through it,
  `Program.id_to_name` (`spur/spur-core/src/compiler/cfg/ir.rs:215`)
- `Type::Struct(NameId, String)`, `Type::Enum`, `Type::Role`
  (`spur/spur-ast/src/types.rs:17-19`), where it must stay a pure function of
  the `NameId` (Section 3.7)
- `Program.roles: Vec<(NameId, String)>` (`cfg/ir.rs:231`, pushed at
  `cfg.rs:263`)
- `DeployMetadata.name` (`spur/spur-ast/src/types.rs:404`, set at
  `checker/topology.rs:176`)

`SourceMap.crates` (Section 4.5) is where `crate_prefix` reads the name. It is
consulted once per declaration, while `id_to_name` is being built, and never
again.

### 7.2 `compiler/cfg.rs`

The function qualifier map (`cfg.rs:260-280`) is the single choke point for
every compiled function name. Two lines change:

| Line | Today | With modules |
| --- | --- | --- |
| `cfg.rs:266` | `let qualifier = role.original_name.clone();` | the role's qualified display name |
| `cfg.rs:277` | `"__free".to_string()` | `raft::__free` in module `raft`, `__free` in the root module |

The five `format!("{}.{}", ...)` sites that consume the qualifier
(`cfg.rs:293`, `:415`, `:1330`, `:1388`, `:1489`) are unchanged in form. So is
`func_name_to_id` (`cfg.rs:246-249`, `:473`, `cfg/ir.rs:211`) and the one
string lookup it serves, `Program::get_func_by_name` (`cfg/ir.rs:252-256`).

The `__free` qualifier must become module-qualified because `func_name_to_id`
is program-wide and two modules may each declare `fn cluster`. It never reaches
a user-visible string: free functions cannot carry `@trace`
(`checker/topology.rs:148` allows only `deploy` on a free function), so no
`__free` name appears in `traces.function_name`.

One consumer must change in lockstep:
`spur/spur-core/src/simulator/deploy.rs:42` builds
`format!("{name}.{suffix}")` from `program.roles` to find `Init`,
`RecoverInit`, `BASE_NODE_INIT`, `Write`, `Read` and `RMW`. With `program.roles`
holding qualified names (Section 7.1), that line is correct with no edit. If
`roles` were left short, `RoleTable::new` would silently find nothing and every
run would fail with `MissingRequiredFunction`.

### 7.3 Deploy and type tables

The tables that `TopologyMetadata` carries (`spur/spur-ast/src/types.rs:424-431`)
are keyed by `NameId` throughout: `roles`, `structs`, `enums`, `tags`. Since
`NameId`s are program-wide and unchanged (Section 3.7), **none of these
structures changes shape**. Modules add a prefix to display strings and nothing
else.

Two values inside them become qualified:

- `DeployMetadata.name` (`types.rs:404`), which is the string a config selects
  with (`"deploy": "raft::Single"`).
- `DeployMetadata.client` is already a `NameId` (`types.rs:405`), resolved
  through the annotation change of Section 3.8.

`select_deploy` (`spur/spur-core/src/simulator/deploy/evaluate.rs:13-23`)
compares `d.name == name`. It gains one convenience rule: when no deploy's
qualified name matches, and exactly one deploy's **short** name matches, select
it; when more than one does, report the ambiguity and list the qualified names.
A program with one `@deploy` is still selected with no name at all
(`evaluate.rs:18-21`).

The short-name rule is worth its small cost because every config in the tree
today says `"deploy": "Main"`, and a deploy in a non-root module is rare enough
that the ambiguity will seldom fire. When it does, the message lists the
qualified names, so the fix is one paste.

Config path resolution (`plan_config.rs`, value paths like
`shards[0].nodes[2]`) is untouched. Those are paths into a deployment *value*,
not into the name space, and they use `.` and `[]` with the meanings they have
today.

### 7.4 Output strings and configs

| Surface | Produced or consumed at | Spelling with modules | Changes for a one-module program |
| --- | --- | --- | --- |
| `traces.function_name` | `cfg.rs:415` via `intern_trace_name`; `core/state.rs:321`; `history.rs:728`, `:762` | `raft::Node.AppendEntries` | no |
| plan `deliver.function` | `plan_config.rs:84`; compared by `==` at `path.rs:1079` against `func_name_to_id` keys (`path.rs:885-898`) | must match the trace spelling exactly | no |
| explorer/plan `deploy` | `explorer.rs:244`, `plan_config.rs:283`, `--deploy` (`spur-cli/src/main.rs:37`, `:100`, `:120`, `:140`), `evaluate.rs:15` | `raft::Single` | no |
| `executions.action` | fixed literals at `path.rs:203-205` | `Client.Write`, `Client.Read`, `Client.RMW`, `System.Crash`, `System.Recover` | no -- these never carried a role name |
| debug node labels | `spur-cli/src/main.rs:831-840` | deployment paths (`nodes[2]`), unchanged | no |
| debug function column | `spur-cli/src/main.rs:970-978`, the `{:<24}` field | widen to `{:<36}`, or compute the width from the longest name in the run | cosmetic |
| `debug combined` | `spur/spur-core/src/debug.rs:305-312`, `:415` | passes the string through | no |

Module part `::`, role and function part `.`. The reasons:

1. The two relations are different. `raft::Node` is a module hop; `Node.Append`
   is member selection inside a role. One notation for both loses information
   that a reader and a tool both want.
2. `func_name_to_id` keys stay parseable: split at the **last** `.` to get
   (qualifier, function); split the qualifier at the last `::` to get (module
   path, role). With dots throughout, `a.b.c` cannot be split at all -- it is
   equally a module `a` with role `b`, and a module `a.b`... which is exactly
   why a module path needs its own separator.
3. Plan configs already use `.` for value paths (`shards[0].nodes`). Reusing it
   for name paths in the same file would put two meanings on one character.

Dots throughout would be simpler for a tool that splits on `.`, and would match
the value-path syntax plan configs already use. It is rejected for the three
reasons above. The cost of `::` is that `deliver.function` strings in plan files
contain it, which is one more thing to spell correctly -- and a misspelling is
already caught by the starvation warning at `path.rs:1142-1160`.

### 7.5 Tools

| Tool | Status |
| --- | --- |
| **porcupine** (`porcupine/checker/checker.go:26-45`) | unchanged. It matches action strings with `strings.HasSuffix` against `Client.Read`, `Client.Write`, `Client.RMW`, `Client.Delete`, `Client.SimulateTimeout`, `System.Crash`, `System.Recover`, and those strings are fixed literals in `path.rs:203-205` that never carried a role name. |
| **traceanalyzer, grade** (`traceanalyzer/metrics/grade.go:90`, `:94`) | unchanged. `action LIKE 'Client.%'` is a prefix match on the same fixed literals. |
| **traceanalyzer, dagorder** (`metrics/dagorder/candidates.go:172-182`) | unchanged. `actionFor` returns the same fixed literals; payload parsing is positional (`candidates.go:113-168`). |
| **traceanalyzer, plan configs** (`metrics/dagorder/planconfig.go:82`, `:288`, `:295`) | code unchanged. A plan file that names a handler in a non-root module must spell it `raft::Node.AppendEntries`, matching `traces.function_name`. |
| **research/lite/tools/ghost_census.py** (`:54-61`, `:485`) | unchanged as long as VR stays a one-module program. The constants are `Node.StartViewChange`, `Node.DoViewChange`, `Node.StartView`, `Node.Prepare`, `Node.PrepareOK`, `Node.Commit`, `Node.Init`, `Client.Write`, plus `Node.Recovery` inline at `:485`. If `bin/spur/VR.spur` is ever split into modules, every one of those nine strings gains a prefix. Recommendation: keep VR single-module (Section 12). |
| **research harness configs** (`research/oracle/*.json`, `research/lite/plans/*.json`, `scheduler_configs/*.json`) | unchanged. All 44 files under `scheduler_configs/` and `scheduler_configs/loop/` name `"deploy": "Main"` and unqualified handlers, which stay correct for one-module specs. |

The honest summary: **no downstream tool needs a code change.** What changes is
the spelling that a multi-module spec's plan files must use, and that is a
property of the spec, not of the tool.

---

## 8. Tooling

### 8.1 LSP

This is the largest hidden cost of the change, larger than the parser, lexer
and resolver edits combined. It is worth stating plainly before the details:
the LSP today compiles one string and publishes one diagnostic list to one URI.
After this change it compiles a program and publishes several diagnostic lists
to several URIs, some of which are not open, and it must decide which program
each open buffer belongs to.

**Document store.** `Backend.documents: Arc<DashMap<Url, String>>`
(`spur/spur-lsp/src/backend.rs:17`) already is the store. It gains a read path
that the loader consults:

```rust
trait SourceReader {
    fn read(&self, path: &Path) -> io::Result<String>;
}
```

The CLI passes a reader that hits the filesystem. The LSP passes one that
checks the document map first, keyed by the URL of the canonicalized path, and
falls back to the filesystem. **An open buffer shadows disk**, so a module
edited but not saved is the version its importers see.

`did_close` (`backend.rs:194-199`) removes the buffer and clears its
diagnostics. With modules, the file is still on disk and still part of
programs, so `did_close` must drop the overlay and trigger a recompile, not
drop the file.

**Entry selection.** The LSP has no explicit entry, so the manifest supplies
one:

> Walk up from the open file looking for `spur.json`. If one is found, load its
> crate; if that crate reaches the buffer, compile that manifest's `root` as
> the entry with the buffer overlaid. Otherwise -- no manifest above the file,
> or a manifest whose root does not reach it -- compile the buffer as its own
> entry, with its own directory as the root, which is the implicit manifest of
> Section 4.1.

The reachability clause is what keeps the rule honest. `bin/spur/spur.json`
governs the sharded example, and `bin/spur/Raft.spur` is not reachable from its
root; without the clause, opening `Raft.spur` would compile `sharded.spur` and
publish no diagnostics for the buffer at all.

Diagnostics from one compile are grouped by `span.context` and published to the
corresponding URI.

**The CLI and the LSP agree on the program a file belongs to.** A file a crate
reaches is compiled as part of that crate by both. A file no crate reaches is
compiled as a one-file program by both. The CLI additionally lets a `.spur`
path name the entry directly (Section 4.1), which changes which program is
built, not what any file means inside it. A module cannot mean one thing under
`spur check` and another in the editor.

Consequences:

- A crate's modules are all compiled by one entry, so one compile covers every
  open buffer in that crate and their diagnostics are consistent by
  construction.
- Two open buffers in two crates that both depend on a third produce two
  compiles reaching the shared crate. Take the union of its diagnostic sets,
  deduplicated by `(range, message)`. The sets agree in practice, because a
  module's diagnostics are a function of the module and its imports and nothing
  else -- there are no conditional modules, no features and no cfg.
- A `.spur` file with no `spur.json` above it is exactly today's case, compiled
  exactly as today. Its `pub` markers are unchecked because nobody imports it,
  and a `use` of a sibling still resolves because the root directory is its own
  parent.
- A change to a `spur.json` invalidates every entry under it, which is the
  coarse but correct behavior: a manifest change can move the root, add a
  dependency or rename a crate. It can also change which buffers the crate
  reaches, so the reachability decision is recomputed with it.

**Per-URI diagnostics.** `compile_result_to_diagnostics(&result, &line_index)`
(`spur/spur-lsp/src/diagnostics.rs:11-40`) takes one `LineIndex`. It becomes
`compile_result_to_diagnostics(&result, &source_map) -> HashMap<SourceId,
Vec<Diagnostic>>`, using the per-file `LineIndex` in the map (Section 4.5).
`analysis_loop` (`backend.rs:60-108`) publishes one call per file that has
diagnostics, and must also publish an **empty** list to every URI that had
diagnostics on the previous pass and does not now. That set is tracked in the
backend; without it, a fixed error in a closed file stays on screen forever.

**What recompiles when one file changes.** After each successful load, the
backend keeps `reached_by: HashMap<PathBuf, HashSet<Url>>`, mapping every
loaded file to the entries whose reachable set contains it. A change to file
`F` recompiles exactly `reached_by[F]`, plus `F` itself if it is open. A file
that is not in the map -- a new file, or one whose importer failed to load --
falls back to recompiling every open buffer.

**Cost.** Worst case is `O(open buffers * modules reached)` lexes and parses
per debounce window (`DEBOUNCE = 200ms`, `backend.rs:66`). A lex+parse cache
keyed by `(path, content hash)` removes the duplication across entries, since
the same module text parses to the same AST regardless of who imports it.
Resolution and checking still run once per entry and are not cacheable, because
they depend on the whole program.

### 8.2 CLI

**Entry points.**

- `compile(input: &str, name: &str)` (`compiler.rs:100`) has 39 call sites, most
  of them compiling an inline source string in a test. It stays, renamed to
  `compile_source(text, name)`, and builds a one-crate, one-module program with
  an implicit manifest and a synthetic `SourceId`. Those call sites change in
  name only.
- A new `compile_entry(path: &Path, reader: &dyn SourceReader) -> CompileResult`
  is the multi-file entry point. It accepts a `spur.json`, a directory holding
  one, or a `.spur` file, and resolves the crate as in Section 8.1. The seven
  `fs::read_to_string` + `compiler::compile` pairs in `spur-cli/src/main.rs`
  (`:341`, `:393`, `:484`, `:519`, `:768`, `:993`, `:1013`) become one
  `compile_entry` call each.
- `CompileResult` gains `sources: SourceMap` and `manifest_errors:
  Vec<ManifestError>`, so a caller can render a diagnostic without re-reading
  any file.
- `spur deploy SPEC --params JSON` (`main.rs:1012-1018`) prints the qualified
  role names in its node table, which is how an author checks that a module
  split produced the names the configs expect.

**Presets.** `--preset NAME` is added to the three subcommands that have
something to resolve: `explore` (`main.rs:83-110`), `run-plan` (`:112-130`) and
`resolve-plan` (`:132-144`). It fills in whichever of `--config`, `--plan`,
`--deploy` and `--set` the preset supplies, and `--output-dir` when the preset
sets one. `check` (`:63-73`), `graph` (`:75-81`), `compile` (`:44-62`) and
`deploy` (`:34-43`) take no `--preset`: a preset's only contribution there
would be the spec, and those subcommands already accept a manifest or a
directory in the `spec` position.

Precedence, from weakest to strongest:

| Layer | Source |
| --- | --- |
| 1 | the preset's `set` array, in order |
| 2 | the `SPUR_CONFIG_SET` environment variable (`config_override.rs:29`) |
| 3 | `--set` and `--deploy` on the command line |

This is the existing order with one layer prepended. `active_overrides`
(`config_override.rs:50-63`) builds the environment list and then extends it
with `set_extra_overrides` (`:42-48`), whose doc comment already states that a
flag wins a conflict; the preset list is prepended to the environment list in
the same function. Layer 3 always wins, so `--set` is still the last word on
any field.

**Guardrail: presets are not a loop input.** The research harness keeps passing
explicit paths. `runners.ts:492` builds
`["explore", "-e", ..., "--config", opts.configPath, ...]` from a config it
materializes itself (`materializeConfig`, `runners.ts:184-202`), and the lite
grader writes its config and passes that path (`research/lite/grader.ts:1665`,
`:1674`). A preset would hide the exact config a measurement ran under behind a
name that can change without the measurement changing, which is the one thing a
grader must not allow. Presets are a human convenience for the interactive
loop; loop inputs keep one path each.

### 8.3 Editor grammar

`spur/editors/code/syntaxes/spur.tmLanguage.json`:

- `:128` `keyword.control.spur`: add `use`, `as`.
- `:133` `storage.type.spur`: add `pub`.
- A new pattern highlights `ID` followed by `::` as
  `entity.name.namespace.spur`, and the final segment of a path as
  `entity.name.type.spur` when it starts with an uppercase letter.
- The role declaration pattern at `:184` and the annotation pattern at `:217`
  are unchanged.

### 8.4 Tests and fixtures

- `spur/spur-core/src/analysis/resolver/test.rs` gains cases for every variant
  in Section 3.9, plus: a private item reached from a descendant module
  (allowed), a private module reached from its parent (allowed), a `pub use`
  chain of length three, a `pub use` cycle, an alias, a name bound in two
  namespaces, and a duplicate import that collides with a declaration.
- A new fixture tree `spur/spur-core/tests/fixtures/modules/` holds the
  multi-file cases: `spur.json`, `entry.spur`, `lib.spur`, `deep/inner.spur`,
  `cycle_a.spur`, `cycle_b.spur`.
- A second tree `spur/spur-core/tests/fixtures/crates/` holds a root crate, two
  dependencies and a diamond, to cover: one `NameId` per item across a diamond,
  a crate cycle rejected by `ManifestDepCycle`, an item reached under two
  aliases producing one display name, and a private item of one crate invisible
  in another.
- Manifest cases: every `ManifestError` in Section 4.1, plus a `.spur` file
  compiled with no `spur.json` anywhere above it, asserting that the resulting
  program is identical to what `compile_source` produces for the same text.
- Handler visibility: an intra-module `->` call to a private handler (allowed),
  a cross-module one (`PrivateHandler`), a cross-crate one to a `pub` handler
  (allowed), and a run that calls `Write`, `Read` and `RecoverInit` on a role
  whose functions are all private, asserting the simulator dispatches them
  regardless (Section 2.6).
- `spur/spur-core/tests/` (20 files compile inline sources) change only where
  the entry function is renamed.
- The fixpoint gets unit tests that assert the **number of pops**, so a
  regression that turns the worklist back into repeated full passes is caught
  by a test rather than by a profile.

---

## 9. Worked examples and migration

### 9.1 Migration of existing specs

Every spec under `bin/spur` and every fixture compiles with **no edit**, and
no `spur.json` is added anywhere. Four facts together make the migration empty:

1. A `.spur` path given to the CLI gets an implicit manifest whose `root` is
   that file, with no deps and no presets (Section 4.1). Nothing is read from
   disk that is not read today.
2. The root crate contributes no prefix and the root module's path is empty, so
   a one-file spec's qualified names equal its short names (Section 7.1). Its
   `traces.function_name` values, its `deploy` selection string and its
   `deliver.function` strings are byte-identical.
3. Visibility never fires. Every declaration and every handler call is in the
   one module, and `check_visible(M, Private, M)` is true (Sections 2.6 and
   3.6), so no `pub` is needed on any role, type, function or handler.
4. Nothing in the language is spelled differently. `use`, `pub`, `as` and `::`
   are additions; no existing spelling changes meaning.

The 38 JSON files directly under `scheduler_configs/` and the six under
`scheduler_configs/loop/`, the plan files under `research/oracle/` and
`research/lite/plans/`, and `research/lite/tools/ghost_census.py` are unchanged
for the same reason.

The only mechanical change is defensive, and it happens per spec at the moment
that spec is first imported: mark its roles, types, builder functions and the
handlers its callers use `pub`, and add a `spur.json` if it is to be a
dependency of another crate.

### 9.2 A multi-file example

The sharded deployment splits into a library module and an entry, in one crate.

`bin/spur/spur.json`:

```json
{
  "name": "sharded",
  "root": "sharded.spur",
  "presets": {
    "debug": { "config": "../../scheduler_configs/sharded_debug.json",
               "deploy": "Sharded" },
    "churn": { "plan": "../../scheduler_configs/sharded_churn.json" }
  }
}
```

`bin/spur/raft.spur` -- the protocol, with no `@deploy` and no client:

```
pub type Raft {
    @quorum nodes: list<Node>;
};

pub type ClientResponse {
    is_leader: bool;
    leader: Node;
    value: list<int>;
};

type LogEntry { term: int; key: string; uid: int; };   // private: the log shape
                                                       // is nobody else's business

pub role Node(cluster: Raft) {
    var me: int = index_of(cluster.nodes, self)!;
    var replicas: list<Node> = cluster.nodes;
    var f: int = std::quorum::f(len(cluster.nodes));
    // ... state and handlers unchanged ...

    // `pub` because the routing tier calls them across a module boundary.
    @trace
    pub async fn AppendEntries(req: AppendReq): AppendResp { ... }
    @trace
    pub async fn Write(key: string, uid: int): ClientResponse { ... }
    @trace
    pub async fn Read(key: string): ClientResponse { ... }

    // Private: only this module drives replication.
    async fn replicate_to(peer: int) { ... }
}

// Allocates one cluster. Every protocol module writes its own; see 10.1.
pub fn cluster(n: int): Raft {
    var nodes: list<Node> = spawn<Node>(n);
    var r: Raft = Raft { nodes: nodes };
    provide_all(nodes, r);
    r
}

// The retry loop every client and router of this protocol shares.
pub async fn write_through(first: Node, key: string, uid: int) {
    var target: Node = first;
    for ;; {
        var resp: ClientResponse = <- target->Write(key, uid);
        if (resp.is_leader) { return (); }
        target = resp.leader;
    }
}
```

`bin/spur/sharded.spur` -- the entry:

```
use raft;
use raft::Node as Replica;
use std::route;

type ShardedKV {
    shards: list<raft::Raft>;
    routers: list<Router>;
    routes: map<string, int>;
};

type ShardParams {
    @scale shards: int;
    @scale replicas: int;
    @scale routers: int;
    @choice route_keys: int;
};

role Router(sys: ShardedKV) {
    async fn Write(key: string, uid: int) {
        var s: int = route::shard_of(sys.routes, key);
        raft::write_through(sys.shards[s].nodes[0], key, uid)
    }

    async fn Read(key: string): list<int> {
        var s: int = route::shard_of(sys.routes, key);
        var target: Replica = sys.shards[s].nodes[0];
        for ;; {
            var resp: raft::ClientResponse = <- target->Read(key);
            if (resp.is_leader) { return resp.value; }
            target = resp.leader;
        }
        []
    }
}

@deploy(client = RouterClient)
fn Sharded(p: ShardParams): ShardedKV? {
    if (p.shards < 1 or p.replicas < 1 or p.routers < 1) { return nil; }
    var shards: list<raft::Raft> = [];
    for var i = 0; i < p.shards; i = i + 1 {
        shards = append(shards, raft::cluster(p.replicas));
    }
    var routers: list<Router> = spawn<Router>(p.routers);
    var sys: ShardedKV = ShardedKV {
        shards: shards,
        routers: routers,
        routes: route::key_routes(p.shards, p.route_keys),
    };
    provide_all(routers, sys);
    sys
}

client RouterClient(sys: ShardedKV) {
    async fn Write(dest: Router, key: string, uid: int) { <- dest->Write(key, uid); }
    async fn Read(dest: Router, key: string): list<int> { <- dest->Read(key) }
}
```

What this program looks like to the rest of the toolchain:

| Thing | Value |
| --- | --- |
| Modules loaded | the root (`sharded.spur`), `raft`, `std`, `std::route`, `std::quorum` |
| Role display names | `raft::Node`, `Router` |
| `traces.function_name` | `raft::Node.AppendEntries`, `Router.Write`, `raft::Node.BASE_NODE_INIT` |
| Free function names | `raft::__free.cluster`, `raft::__free.write_through`, `__free.Sharded` |
| `deploy` selection | `"deploy": "Sharded"` -- the deploy is in the root module |
| `executions.action` | `Client.Write`, `Client.Read` -- unchanged |
| Not visible outside `raft` | `LogEntry` and `Node.replicate_to` |
| Manifest | one crate, no deps; the loader reads `bin/spur/spur.json` once |
| Preset | `spur explore --preset debug bin/spur` |

A plan config for this program:

```json
{
  "deploy": "Sharded",
  "params": { "shards": 2, "replicas": 3, "routers": 1, "route_keys": 4 },
  "events": {
    "w1": { "write": { "dest": "routers[0]", "key": "key1" } },
    "d1": { "deliver": { "function": "raft::Node.AppendEntries",
                         "from": "shards[0].nodes[0]", "to": "shards[0].nodes[1]" } }
  },
  "dependencies": [["w1", "d1"]]
}
```

Note that `dest`, `from` and `to` are value paths into the deployment and keep
their `.` and `[]` syntax; only `deliver.function` is a name path.

### 9.3 An import that fails

```
// sharded.spur
use raft::LogEntry;
```

`LogEntry` is declared without `pub` in `raft.spur`, so `check_visible(raft,
Private, root)` fails: the root module is not a descendant of `raft`. One
diagnostic, `PrivateItem`, is reported at the `use` site, a poison binding is
installed under `LogEntry`, and every use of `LogEntry` in `sharded.spur`
resolves to `Type::Error` with no further diagnostic (Section 5.4).

### 9.4 A private handler

```
// sharded.spur, inside role Router
<- target->replicate_to(0);
```

`replicate_to` is declared without `pub`, so the checker resolves the name
(`role_funcs.get("replicate_to")` succeeds) and then fails
`check_visible(raft, Private, root)`, reporting `PrivateHandler` at the call
(Section 2.6). The handler's name was never in question; only who may call it
was. A run of the same program is unaffected either way, because the simulator
dispatches by function id and never consults the bit.

---

## 10. What modules do not solve

### 10.1 Generics over role types are out of scope

`spawn<R>(k)` requires `R` to name a concrete role declared with `role`
(`checker/topology.rs` and `spur/design/language.md:281-303`). A function that
spawns is therefore tied to one role, and a type that holds spawned handles is
tied to one role:

```
fn cluster(n: int): Raft {           // Raft mentions Node; Node is concrete
    var nodes: list<Node> = spawn<Node>(n);
    ...
}
```

So **a shared `cluster(n)` builder cannot live in the standard library**. Each
protocol module writes its own, as `raft.spur` does in Section 9.2. The same
limit applies to:

- any function that takes or returns a role handle, including a retry-to-leader
  loop (Section 6.1)
- any struct holding `list<R>`, which is every deployment root type
- any deploy function

The library is therefore limited to primitives and collections of primitives
(Section 6.1), and the per-protocol duplication of builders and client loops
stays. What modules remove is duplication *within* a protocol family: the 14
files in `bin/spur/panel/` and the 5 in `bin/spur/mencius/` could each become a
small module over a shared library module, if they differed structurally --
which they do not (Section 10.2).

Adding generics later is the way out. The shape it would take: a type parameter
on a free function and on a struct, `fn cluster<R>(n: int): list<R>`, with
`spawn<R>` accepting a type parameter that is known to name a role. That needs
a bound (`R: role`), monomorphization at the deploy site, and a rule for how
`role_func_signatures` is consulted for an unknown `R` -- which is a second
design of its own size. Nothing in this document forecloses it: `NameId`
identity, the module tree and the qualified-name scheme are all orthogonal to
type parameters.

### 10.2 Modules do not deduplicate the panel variants

The 14 files under `bin/spur/panel/` are variants of Raft and Paxos that differ
by a few lines inside a handler body. For example, `raft_clean.spur` and
`raft_stale_vote.spur` differ by exactly one guard, five lines, inside one
handler.

Modules cannot express that. A module imports items whole; there is no way to
import a role and override one of its functions, and adding one would mean
adding inheritance to a language that has none.

The right collapse for these files is the mechanism the language already has: a
`@choice` parameter on the deploy struct, carried into the role parameter, and
read at the site that differs.

```
type RaftParams {
    @scale n: int;
    @choice check_reply_term: bool;
};

type Raft {
    @quorum nodes: list<Node>;
    check_reply_term: bool;
};

// inside the handler
if (cluster.check_reply_term and resp_term != current_term) {
    return ();
}
```

One file, one grid axis, and the explorer covers both variants in one session
instead of two. That is a separate change from this one, it does not depend on
modules, and this design does not promise it.

---

## 11. Decisions

Every question this design raised is settled. The reasoning for each lives in
the section that depends on it; the list is here so a reader can see the shape
of the whole in one place.

| # | Decision | Reasoning |
| --- | --- | --- |
| 1 | Output strings and configs spell a qualified function `raft::Node.AppendEntries`: `::` for the module part, `.` between a role and its function | Section 7.4 |
| 2 | Private means visible in the declaring module and its descendants, not visible only in the declaring file | Section 2.4 |
| 3 | There is no prelude. `std` is pre-bound in every module instead | Section 6 |
| 4 | Brace lists in `use` are deferred, as parser-only sugar | Section 2.3 |
| 5 | The standard library is embedded in the binary, not a directory | Section 6 |
| 6 | `"deploy"` accepts an unqualified short name when exactly one deploy matches | Section 7.3 |
| 7 | The manifest is `spur.json`: JSON, lowercase, not hidden | Section 4.1 |
| 8 | Presets live in the manifest, not in a file of their own | Section 4.1 |
| 9 | `deps` is path-only and never grows versions | Section 4.3 |

---

## 12. Phased implementation plan

This is a front-end change. Nothing in `spur/spur-core/src/simulator/core/`
changes. `explorer.rs`, `scheduler.rs`, `state.rs`, `exec.rs` and `path.rs` are
untouched, with one exception noted in Phase 4.

**Iteration boundaries.** The autonomous research loop reads
`traces.function_name` (through `research/lite/tools/ghost_census.py:54-61` and
the plan files under `research/oracle/`) and the `deploy` selection string in
`scheduler_configs/loop/*.json`. Those strings change only for programs that
use more than one module. `bin/spur/VR.spur` is one module and stays one
module, so **no phase changes a loop input**. Phase 4 is still landed at an
iteration boundary as a precaution, with a parity gate; Phases 1, 2, 3, 5 and 6
need none.

Three parts of this change could have moved that line, and none does:

- **The manifest.** No `spur.json` is added to this repository, and the loop's
  invocations pass `.spur` paths, which get an implicit manifest (Section 4.1).
  The loop reads no manifest and writes none.
- **Presets.** The harness stays on explicit `--config` and `--plan` paths
  (Section 8.2), so a preset can never become an input to a measurement.
- **Handler visibility.** Every loop spec is one module, so the check never
  fires (Section 9.1).

**Phase 1: spans carry a file id.**
- `SourceId`, `SourceMap`, `SourceFile`, `LineIndex` moved into `spur-core`,
  with the `display` uniqueness invariant (4.5).
- `Span = SimpleSpan<usize, SourceId>` (4.6); lexer constructor and the 19
  `Span { .. }` literals; the 14 parser bounds; `make_input` and
  `parse_program`.
- Reporting: the 49 `Report::build` sites and the three `report_*` signatures
  (4.7).
- `compile_source` keeps today's behavior with `SourceId(0)`.
- No language change, no output string change, no config change.
- Gate: the existing test suite passes unchanged, and the diagnostics of a
  deliberately broken spec render identically.

**Phase 2: manifests and the loader.**
- `spur.json` parsing, the implicit manifest, root resolution, the crate graph
  and its cycle check, `ManifestError` and its reporting (4.1, 4.3).
- File discovery, `target_of`, duplicate and depth checks, module cycles, the
  DFS forest walk (4.2, 4.4).
- `SourceReader`, `compile_entry`, `CompileResult.sources` and
  `CompileResult.manifest_errors` (8.2).
- Still no language change: with no `use` in any file, every program has one
  crate and one module and the loader loads one file.
- No `spur.json` is added to the repository in this phase or any later one.
- Gate: a fixture tree loads with the expected module paths and intervals; a
  symlink loop produces `ModuleTooDeep` rather than a hang; a crate cycle
  produces `ManifestDepCycle`; every existing spec still compiles through the
  implicit manifest with no file added.

**Phase 3: grammar, per-module tables, resolution.**
- Lexer `::`, `use`, `pub`, `as`; the parser's path productions and
  `UseDecl` (2.1).
- `ModuleTable`, per-module namespaces, declaration install sweep (3.2, 3.3).
- Dependency aliases pre-bound in every module of a crate (4.3).
- The worklist fixpoint, poison bindings, the blocking graph (5.1-5.4).
- `check_visible` and its four call sites, including the RPC check and
  `FunctionSignature`'s two new fields (2.6, 3.6).
- Path-valued annotation arguments and the `checker/topology.rs:154` change
  (3.8).
- The error catalog and its LSP arms, including `PrivateHandler` (3.9).
- Display names are still short, because every existing spec is one crate and
  one module.
- Gate: the resolver test suite of 8.4; every spec in `bin/spur` compiles to a
  byte-identical `Program`, with no `pub` added anywhere.

**Phase 4: qualified display names (iteration boundary).**
- `cfg.rs:266` and `:277` (7.2); `program.roles`, `id_to_name`, `Type::*`
  display strings, `DeployMetadata.name` (7.1).
- `select_deploy`'s short-name rule (7.3).
- The debug column width (`spur-cli/src/main.rs:974`).
- The one simulator-adjacent line: `deploy.rs:42` needs no edit but must be
  verified against qualified `program.roles`.
- Gate: run the VR grid used by the loop's throughput measurement before and
  after, and require **byte-identical** `traces`, `executions` and `logs`
  tables. A one-module program must produce the same strings it does today.
  Scaffolding removed at the end of the boundary.

**Phase 5: standard library.**
- `stdlib.rs`, the five modules of 6.1, reserved `SourceId`s, `std` pre-bound
  in every module.
- Gate: a spec that imports `std::quorum` compiles and runs; a spec that does
  not is unaffected.

**Phase 6: tooling, docs and the example.**
- LSP multi-file compile, the walk-up entry rule and its reachability clause,
  document store, per-URI diagnostics, the `reached_by` map (8.1).
- `--preset` on `explore`, `run-plan` and `resolve-plan`, and the third
  override layer in `active_overrides` (8.2).
- Editor grammar (8.3).
- `spur/design/language.md` gains the grammar of 2.1 and "Modules" and
  "Crates" sections; `docs/agent/language.md` gains a short module section;
  `CLAUDE.md` gains the file-is-a-module rule, the `spur.json` schema and the
  `--preset` flag.
- `bin/spur/spur.json`, `bin/spur/raft.spur` and `bin/spur/sharded.spur` (9.2),
  with their configs. This is the first `spur.json` in the repository, and it
  governs only the new example.

**Follow-up changes**, each its own merge, none a prerequisite:

- brace lists in `use`, as parser-only sugar (2.3)
- a prelude, built out of `pub use` (2.4, Section 6)
- generics over role types (10.1)
- collapsing the panel variants with `@choice` (10.2)

---

## Appendix A. Rejected alternatives

**A.1 `mod` declarations.**
- A `mod foo;` line plus a `foo.spur` file is two places to keep in sync, and
  the failure mode -- a file that exists and is silently not part of the
  program -- is invisible in the file itself.
- It buys inline modules (`mod foo { ... }`) and the ability to have a file
  that is deliberately not compiled. Neither is worth a second source of truth
  for a language whose programs are a handful of files.
- Without `mod`, the module path is a function of the file path, so a reader
  who can see the directory can compute every qualified name.

**A.2 A manifest that lists modules, or a crate that is a compilation unit.**
- A manifest that enumerates modules is a second source of truth next to the
  directory tree, with the same failure mode as `mod` (A.1). `spur.json` names
  a root, dependencies and presets, and nothing else (Section 4.1).
- Making a crate a compilation unit -- its own resolver, its own name counter,
  its own cache -- adds a second id space that every `NameId` would have to
  carry, and a publish step between the two that has to be kept in order. That
  is precisely the shape of tygr's first two defects (Appendix B.2.1, B.2.2).
  One resolver over the whole crate graph costs nothing at this scale: a
  program is a few thousand lines.

**A.3 TOML for the manifest.**
- TOML would add a dependency to a workspace that has none, for a file whose
  shape is three keys and two maps.
- Every configuration this project owns is JSON, read with `serde_json`
  (`spur/spur-cli/Cargo.toml:26`, `spur/spur-core/Cargo.toml:38`), and the
  TypeScript harness parses JSON with no extra code. One format is worth more
  than a slightly friendlier syntax.

**A.4 A search path.**
- A list of directories makes a `use` path's meaning depend on the invocation,
  so the same spec compiles differently under the CLI and under the LSP. The
  manifest gives one answer to "which crate is this file in", used by both
  (Section 8.1).
- Rejected for the same reason as `--std-path` (Section 6): a recorded run must
  reproduce from the spec and the binary alone.

**A.5 Versioned dependencies.**
- A `version` field needs a registry to resolve against, and a registry needs
  fetching, caching, integrity checking and offline behavior before it is
  usable at all.
- Without a registry the field would be an unchecked comment. `deps` is
  path-only (Section 4.3).

**A.6 Glob imports.**
- A glob makes a name's source invisible at the use site, which is the opposite
  of what a protocol spec wants when two modules both declare `Node`.
- It forces three extra rules into resolution: shadowing precedence, ambiguity
  bindings, and a coarser wake key in the fixpoint (2.3).
- The convenience it buys is one `use` line per imported module.

**A.7 Per-module `NameId` spaces.**
- A `(ModuleId, u32)` pair, or a `krate` field on every name, would let modules
  be resolved independently and cached.
- It requires every map keyed by `NameId` to change, every counter to be
  per-module, and every downstream consumer to carry the module. The tygr
  experience (Appendix B, defect 2) is that two counters over one id space
  collide silently and produce wrong types rather than an error.
- One counter costs nothing: resolution is one pass over one program, and the
  program is a few thousand lines.

**A.8 Qualifying RPC handler names and enum variants.**
- Both are already scoped by something that a path resolves: the role, and the
  enum. Qualifying them would add a second resolution path with its own
  visibility rules for no new expressiveness.
- Keeping them late-bound strings is what makes Section 2.5 a two-sentence rule
  rather than a subsystem. Handler visibility (Section 2.6) rides on the
  existing lookup: it reads a bit off the signature the checker just fetched,
  and moves no name anywhere.

**A.9 A reserved first segment for the crate root.**
- `crate::Foo`, as tygr spells it (`PathBase::Crate`, `src/parser.rs:16-44`),
  would let a `use` name an item of the entry spec, and `super::` would let a
  module name its parent's.
- Both exist to give a crate-absolute path a way to reach names that are not
  under a named module. Here there is exactly one such place, the entry spec,
  and an entry spec that other modules import is a library that should be
  named (Section 3.1). Adding the marker would make "put it in a library
  module" optional, and the file that runs the deployment would quietly become
  the place shared types accumulate.
- `super::` is rejected with it: a module that needs its parent's items can
  name them through the parent's own path, and a relative marker would give one
  item two spellings whose meaning depends on where it is written.

**A.10 Presets as a general config layer.**
- Letting a preset be selected by an environment variable, or letting one
  preset extend another, would make the config a run actually used a function
  of more than the command line.
- A measurement must be reproducible from the command it ran, so presets stay
  a flat, explicitly named, weakest override layer (Section 8.2), and the
  research harness does not use them at all.

---

## Appendix B. Prior art: tygr

`tygr` is a separate language by the same author with a Rust-like module
system: `mod` declarations, a `Tygr.toml` manifest, crates, `crate::` and
`super::` path bases, `pub use`, and DFS-interval visibility. It is the closest
prior art, and its defects are the most useful part of it.

Line references in this appendix are to the tygr working copy at commit
`d87f001`.

### B.1 What transfers

| Idea | Where in tygr | Adopted here |
| --- | --- | --- |
| `SourceId` in the span context | `src/parser/ast.rs:4-11`, `pub type Span = SimpleSpan<usize, SourceId>` | Section 4.6, identically |
| A reserved synthetic id | `SourceId::SYNTHETIC = SourceId(0)`, `src/parser/ast.rs:7-9` | Section 4.5, plus reserved ids for the standard library |
| A source map that the diagnostic renderer reads | `FileSources`, `src/sources.rs:7-28`, implementing `codespan_reporting::files::Files` | Section 4.5, with ariadne instead of codespan |
| DFS entry/exit intervals for visibility | `DfsScope { entry, exit }`, `src/driver.rs:71-75`, stamped at `:142-143` and `:208-209` | Section 3.6, identically |
| A recursion limit on module loading | `RECURSION_LIMIT = 256`, `src/driver.rs:13`, `:134-139` | Section 4.4, as a depth cap and a module-count cap |
| A crate manifest naming a root and path-only dependencies | `Manifest`, `src/manifest.rs:10-12`, `:58-64` | Section 4.1, as `spur.json` with no `type` field and no module list |
| A dependency alias bound as a path's first segment | the extern prelude built from `Manifest.dependencies` | Section 4.3, with the defining crate's `name` fixing the display name |
| Crate deduplication and a crate-graph toposort | `src/module.rs:200-321` | Section 4.3, as deduplication by canonical manifest path plus a cycle error |
| An import worklist that retries until it makes no progress | `resolve_imports`, `src/analysis/resolver.rs:739-798` | Section 5.1, as a wake-list worklist rather than repeated passes |
| Duplicate-module detection | `src/driver.rs:152-158` | Section 4.4, extended to canonicalized paths |

What does not transfer:

- `mod` declarations, inline modules, and the `crate::` and `super::` path
  bases (A.1, Section 2.2).
- TOML. `Tygr.toml` becomes `spur.json` (A.3).
- The crate as a compilation unit. tygr compiles each crate with its own
  `ResolveContext` and publishes it into a shared `World`
  (`src/analysis/resolver.rs:966-1037`); here one `Resolver` covers the whole
  crate graph (Section 4.3).
- `CrateId` as part of a name. tygr's `GlobalName { krate, name }` and
  `GlobalType { krate, name }` (`src/analysis/resolver/ast.rs:63-87`) have no
  counterpart: `NameId` stays one `usize` (Section 3.7). This design's
  `CrateId` (Section 4.5) indexes the source map and nothing else.
- Binaries and libraries as distinct crate types (`src/manifest.rs:58-64`).
  A Spur crate has a root spec; whether it is used as a deployment or as a
  library is a property of the program that imports it.

### B.2 Five verified defects

All five were checked against the tygr working copy. Each entry gives the
defect, then the one property of this design that makes it impossible.

**B.2.1 The import pass publishes a stale snapshot, and bodies never see the
imports.**
`resolve_imports` (`src/analysis/resolver.rs:739-798`) publishes
`world.crates.insert(resolved.crate_id, resolved.clone())` at `:745-748`, the
**top** of each pass, before any of that pass's imports are installed. It
breaks at `:784-786` when the queue empties, without republishing.
`import_resolution` (`:663-737`) mutates the local `resolved`, never the
`world` copy. The only other publish is `world.crates.insert(id, resolved)` at
`:1035`, which runs *after* `resolve_bodies` at `:1033`. Since bodies resolve
every path through `scope_ctx.world` (`analyze`, `:1322-1342`), and the common
case is that all imports resolve in pass 1, `world` holds the pass-1-start
snapshot in which **no import is installed at all**: every `use`-introduced
name is invisible to body resolution and reports `VariableNotFound` (`:1344`).
The `resolved.clone()` at `:748` additionally deep-copies the whole crate --
`CrateDefMap` carries `defs_to_resolve: HashMap<Name, (Definition, ModuleId)>`
and each `Definition` owns an `Expr` (`src/parser/ast.rs:101-109`) -- once per
import pass.

*Avoided by:* one mutable module tree and no snapshot at all (Section 5.1).
Bodies resolve against the same `ModuleTable`s the fixpoint filled, so an
import installed by the fixpoint's last action is visible to the first body
(Section 5.5). Nothing is cloned; `install` is a `HashMap::insert` into the
module it belongs to.

**B.2.2 Two name counters over one id space.**
`resolve_bodies` (`src/analysis/resolver.rs:800-807`) builds its
`ResolveContext` with `..Default::default()`, whose `next_id` is `Name(0)`
(`:63-73`), while top-level declarations mint from the long-lived `global_ctx`
(`declare_def`, `:533`), which also starts at `Name(0)` (`:137`). Both stamp
`krate: Some(crate_id)` -- locals at `:1127-1135`, definitions at `:948-952` --
and locals are stored as `GlobalName` in the inference `Environment`
(`src/analysis/inference.rs:245`, inserted at `:997-1003` and `:1633`). The
`global_ctx` counter is pre-advanced by 33 builtins (`:141-164`), so the
collision fires once a crate's cumulative local count passes 33. The type
namespace is worse: `ctx.next_type` restarts at `TYPE_BASE = TypeName(6)`
(`:69`, `src/builtin.rs:148`) and `global_ctx.next_type` is **not** pre-advanced
at all, so the first declared variant and the first generic parameter in a
crate are the same `GlobalType` with zero offset.

*Avoided by:* one counter, `Resolver::next_id`, used by one `Resolver` for
declarations and locals in every crate of the graph (Sections 3.7 and 4.3).
There is no per-crate context and no second context to default-construct,
because a crate is a source root and a configuration rather than a compilation
unit. The invariant is stated as a rule rather than maintained by coincidence:
modules and crates affect lookup, never identity.

**B.2.3 A module hop checks the child instead of the parent.**
`src/analysis/resolver/ast.rs:452-463` passes `*next_mod_id` -- the module being
entered -- as `check_visibility`'s `def_module`, while the item check twenty
lines above passes `current_module`, the containing module (`:393-401`, and the
type twin at `:425-433`). `check_visibility`'s `Private` arm requires the
defining scope to **contain** the user scope (`:494-499`), and DFS intervals
nest strictly (`src/driver.rs:142-143` vs `:208-209`), so a private `mod b`
inside `a` is unreachable from `a` itself and reachable only from inside `b`.
Exactly backwards.

*Avoided by:* one helper, `check_visible(owner, vis, use_site)`, where `owner`
is a **field of the binding** rather than an argument chosen at the call site
(Section 3.2). A module hop, a final item and an RPC handler read the same two
fields of the structure they were just looked up in, so the calls cannot
disagree. Section 3.6 spells out all three path calls for `a::b::C`, adds the
handler call, and states the rule as "the module that contains the binding,
never the module being entered".

**B.2.4 The final segment is never looked up in the module namespace.**
`src/analysis/resolver/ast.rs:386-451`: the `is_last_segment` branch consults
only `mod_data.definitions` (`:393`, value namespace) or `mod_data.types`
(`:425`, type namespace) and then falls through to `VariableNotFound` at `:451`.
`mod_data.modules` is consulted only in the non-last branch (`:453`). There is
no `Namespace::Module` variant (`:340-343`), so nothing can even ask for one.
`use a::b;` naming a module can therefore never resolve, and
`import_resolution`'s fully written `Resolution::Module` arm
(`src/analysis/resolver.rs:729-734`) is dead code -- `Resolution::Module` is
declared at `src/analysis/resolver/ast.rs:278` and constructed nowhere.

*Avoided by:* `modules` is one of four namespaces in `ModuleTable`
(Section 3.2), and Section 3.4 makes the rule explicit: **the final segment is
looked up in all four namespaces**, and the `use` installs into every namespace
where it is bound. The table in 3.4 lists the module case first. A test in 8.4
covers `use a::b;` binding a module.

**B.2.5 Constructor patterns consult a map the crate path never fills, and the
pattern grammar has no path form.**
Confirmed in full. `PatternKind::Constructor` resolution
(`src/analysis/resolver.rs:1156-1179`) reads
`scope_ctx.global_constructors` (declared `:105`, initialized empty `:118`),
which is written in exactly one place, `define_global_variant` (`:446-448`),
called only from the REPL and script paths (`src/repl.rs:284`,
`src/compiler.rs:102`, `:219`). The crate path uses `declare_variant`
(`:578-628`), which registers constructors into the module's `definitions` and
never touches `global_constructors`. Every constructor pattern in a compiled
crate therefore fails with `ConstructorNotFound`. Even when the map is filled,
the resolved ids are stamped `krate: None` (`:1168`, `:1172`) while the real
ones are `krate: Some(crate_id)` (`:890-893`). The expression position has a
fallback through `world.resolve` (`:1322-1342`); `analyze_pattern` has none.
And the grammar cannot express a fix: `PatternKind::Constructor(String,
Option<Box<Pattern>>)` (`src/parser/ast.rs:28`) holds a bare `String`, the
parser accepts only `ident().then(tuple_pat.or_not())`
(`src/parser.rs:109-121`), and `docs/ebnf.md:73-80` specifies no qualified
form.

*Avoided by:* two properties. First, Spur's pattern grammar already carries a
type name -- `PatternKind::Variant(enum_name, variant_name, payload)`
(`spur/spur-core/src/parser.rs`, resolved at
`spur/spur-core/src/analysis/resolver.rs:963-976`) -- and Section 2.1 makes
that first position a `path`, so a qualified constructor pattern is expressible
by construction. Second, the enum is resolved through `lookup_type`, the same
function every other type position uses, and the variant name stays a string
checked by the checker (Section 2.5). There is no separate constructor map to
forget to fill.

### B.3 Two further findings

Neither is on the list above; both are recorded because this design must not
reproduce them.

- **Per-crate `SourceId`s against a shared source map.** `load_module` creates a
  fresh `LoadState` per crate (`src/driver.rs:295-316`), so `SourceId`s restart
  at 1 for every crate, while `FileSources` is shared across crates
  (`src/module.rs:55`, `:141`, `:353`). Crate 2's files overwrite crate 1's
  entries, and crate 1's diagnostics then render against crate 2's text.
  *Avoided by:* one `SourceMap` per program, with ids assigned in load order
  from one counter, and a `CrateId` that indexes the source map rather than
  partitioning it (Sections 4.3 and 4.5).
- **Import errors are discarded.** `src/analysis/resolver.rs:754` and `:765`
  use `if let Ok(res) = ...`, throwing away the real `ResolutionError` for
  every import. A `PrivateItemAccess` or `ModuleNotFound` is replaced by a
  `VariableNotFound` pointing at `unresolved_imports[0]` (`:788-794`) -- often a
  different import than the one that failed, which is what masks defects 3 and
  4 from a user. The whole pipeline is fail-fast: every stage propagates the
  first error with `?`.
  *Avoided by:* accumulation into `Vec<ResolutionError>` throughout
  (Section 5.4), a `Failed` arm that records the specific error at the specific
  span, and the blocking graph of Section 5.3, which names the actual members
  of a stuck set instead of picking the first parked import.
