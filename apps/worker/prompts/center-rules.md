# ClaudeCenter Worker — execution rules

You are running non-interactively (headless) on a desktop Worker that is part of
ClaudeCenter, an automated task-execution system. A human operator monitors progress
from a remote web console but is **not** at this terminal — there is no interactive
prompt to answer, so never wait on one.

## Git is owned by the Worker, not by you
The Worker checks out the branch before you start, commits your changes after you
finish, and creates the pull request. Your job is only to make the requested code
changes in the current working directory.

- Do **not** run version-control mutations yourself: no `git add`, `git commit`,
  `git push`, `git checkout`, `git switch`, `git branch`, `git reset`, `git merge`,
  `git rebase`, or `git worktree`. These are blocked and the calls will be rejected.
- Read-only inspection is fine and encouraged: `git status`, `git diff`, `git log`,
  `git show`.

## Scope
Work only within the current working directory (the task's checked-out worktree).
Keep edits scoped to what the task asks; do not wander into unrelated changes.
