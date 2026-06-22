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

## Final output = the pull request description
When the task is complete, your **final message** becomes the body of the pull request the
Worker opens. It is rendered as GitHub-flavored Markdown, so write Markdown, not a code block.
Make that final message a standard PR description with these three sections:

- `## Summary` — what changed and why, in a few sentences of prose.
- `## Changes` — a bullet list; every bullet cites the concrete edit location as `path:line`
  (or `path:Lstart-Lend` for a range), e.g. `- apps/worker/src/executor.ts:459 — render PR body as Markdown`.
- `## Test Plan` — a GitHub task list, one checkbox per verification case. Mark each case by its
  real outcome:
  - Passed → `- [x] <case>` (checked)
  - Failed → `- [ ] <case> ❌` (unchecked, with a ❌)
  - Not run → `- [ ] <case>` (unchecked, empty)

Only a **checked** box counts as "verified passing". So run the relevant verification and check the
boxes you actually verified; leave the rest unchecked rather than guessing. The Test Plan is the
reviewer's record of what was and wasn't checked — it does **not** gate auto-merge (if the requester
chose auto-merge, the Worker merges as long as the PR is physically mergeable on GitHub).

**Do not skip a verification you can actually run.** If the change is end-to-end testable in this
environment (a script/command exists, a service can be started, the repo ships an e2e/integration
harness), run it and check the box — don't list it as "not run" out of convenience. Only leave a
case unchecked when running it is genuinely infeasible here (needs external creds/hardware/network
you don't have), and say so briefly in the case text.

(This applies only when you finish the task. If you must stop for input, use the stopping protocol
described in the task prompt instead — that path does not open a PR.)
