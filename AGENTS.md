# rb-output development rules

## Delegation and concurrency

- Keep decomposition, instruction design, integration decisions, and completion claims under the supervising `gpt-5.6-sol` agent.
- Use the capability hierarchy `gpt-5.6-sol` > Zen/Ox `opencode/x-preview-f-free` > `gpt-5.6-terra` > `gpt-5.6-luna`.
- Ox-alpha is the default delegated worker for almost every bounded implementation, investigation, and independent adversarial review whenever it is callable and suitable. Start with Ox before assigning the same class of work to Terra or Luna.
- Use Terra at high/xhigh effort for additional difficult implementation or review capacity. Terra-authored implementation requires an independent Ox adversarial review before integration.
- Use Luna at max effort only for small, explicit, low-ambiguity work that the Sol supervisor has already decomposed into a narrow assignment.
- Keep every safely usable Codex lane occupied until the requested product outcome is complete. When a lane finishes, immediately reassign it to a concrete non-overlapping implementation, adversarial review, evidence audit, documentation/version checkpoint, hardware preflight, or cleanup task.
- Work in parallel by default and eliminate avoidable waiting. Serialize only true dependencies, exclusive hardware/UI operations, destructive actions, or files with an active owner.
- Give concurrent writers explicit, non-overlapping file ownership. Independent reviews remain read-only until the implementation owner reports a stable checkpoint.
- The Sol supervisor must inspect the integrated diff and rerun the relevant gates; delegated summaries are evidence inputs, not completion proof.

## Checkpoints, Git, and versions

- At every meaningful checkpoint, update the relevant release/QA/handoff documents with branch, HEAD, upstream equality, exact gates, first-party warning counts, remaining blockers, and the next action.
- After a checkpoint passes, create a meaningful commit and push it. If push fails, preserve the commit and record the exact failure and recovery action.
- Advance the product prerelease/version when a distributed development artifact changes. Keep package metadata, artifact names, provenance, documentation, and user-visible version text synchronized.
- Never mark DJ-PC, pedal, Rekordbox, LAN, Syndocal ACK, packaging, or other external acceptance complete from mocks or static tests. Record observed hardware facts separately from unverified gates.

## Cleanup obligation

- Treat stale build products, caches, duplicate packages, temporary worktrees, and superseded artifacts as a continuing cleanup obligation rather than a one-time task.
- Before deleting, resolve and verify every exact absolute target and prove it is regenerable or superseded. Preserve source, current release artifacts, QA evidence, user-authored files, and active worktrees.
- Delete verified obsolete material at checkpoints, record the exact paths and reclaimed bytes, then rebuild or revalidate any dependency surface that may have shared links or caches.
- If deletion is blocked or safety is not yet proven, leave the data intact and record the blocker; never broaden a deletion target by glob, unresolved variable, or guessed ownership.
