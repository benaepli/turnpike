# Code Style

Applies to every file in this repository, whether written by a person or an
agent. Comments are read by someone who has never seen this conversation,
plan, or previous version of the code.

1. A comment states a constraint or intent the code cannot show by itself.
   It never describes what the next line does, and never explains why a
   change was made.
2. No history. Do not mention previous implementations, removed code, earlier
   behavior, bugs that were fixed, iteration numbers, dates, or people.
   That belongs in the commit message.
3. No plan references. Do not cite "the plan", "phase 2", "the audit",
   hypothesis ids, or documents that explain the roadmap.
4. Plain words. No project jargon or abbreviations that a new reader would
   have to look up; spell the concept out or name the function.
5. ASCII only in source files: use "-" not em dashes, "->" not arrows,
   ">=" not the unicode symbol, "..." not the ellipsis character.
6. Removals leave no trace: when deleting or replacing code, do not leave a
   comment saying what used to be there.

Commit messages carry the history and the reasoning; code carries the
present.
