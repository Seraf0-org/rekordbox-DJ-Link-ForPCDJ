# rb-output development rules

## Scope and completion

- Carry the authorized task through implementation and relevant verification. A review-only request produces findings, not edits. Follow the user's explicit scope and stopping conditions.
- Read only the instructions and references relevant to the task. Historical checkpoints record evidence; their next actions, approvals, and temporary ownership rules do not govern new work.
- Parallel agents are optional; use them when the benefit of independent work exceeds coordination cost. Assign non-overlapping writer ownership; the primary agent reviews integrated changes and completion evidence. Choose available models by task needs, without a fixed hierarchy or lane-occupancy quota.
- Run checks proportionate to the changed behavior. After they pass, repeat or broaden checks only for new changes, failures, or unresolved concerns. Documentation-only edits need document/diff checks, not a product build or hardware session.

## Task-specific references

- For setup and launch operations, use [README.md](README.md).
- For HTTP endpoints and wire formats, use [API.md](API.md).
- For cross-repository ownership, pedal behavior, and recorded acceptance evidence, consult the relevant current contract or dated checkpoint in [SYNDOCAL_PEDAL_HANDOFF.md](SYNDOCAL_PEDAL_HANDOFF.md).
- Use skills when their workflow applies; load only the supporting references needed for that workflow. Explicit user instructions and existing session authorization take precedence over skill defaults.

## Git, releases, and evidence

- Preserve unrelated work. Commit and push when included in the authorized task or release workflow; a passing check alone does not require either action.
- When changing a distributed artifact, synchronize its version, package metadata, artifact names, provenance, documentation, and visible version text. Source version and production schema version may differ intentionally.
- At release or handoff checkpoints, record the relevant revision, checks actually run, warnings, outstanding acceptance, and next action. Label upstream comparisons as local tracking or live remote observations.
- Mocks and static tests do not prove DJ-PC, pedal, Rekordbox, LAN, Syndocal ACK, or packaged-install acceptance. Keep observed software, packaging, and hardware evidence distinct.

## Cleanup when in scope

- Before deleting obsolete material, verify each exact absolute target and that it is regenerable or superseded. Preserve source, current release artifacts, QA evidence, user files, and active worktrees. If ownership or safety is uncertain, leave it intact and report why. Revalidate shared dependencies only when the deletion could affect them.
