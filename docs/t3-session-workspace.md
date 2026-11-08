# T3 workspace operations

Status: authored source, not runtime-qualified or bound. This change enables no
executor capability. The source is T3 `25bf84ab07f53f141c20239c63e383823a9d5ea0`;
the reference checkout's current branch is not an input.

## Original implementation and package boundary

`@nessie/t3-session-source/engine` exports `Workspace`. Its
`createWorkspaceLayers()` returns the original Git workflow, review,
checkpoint store/query, checkpoint service, rollback and VCS provisioning
layers. Construction supplies no filesystem, Git driver, provider, database,
credential or lifecycle owner. The checkpoint query requires the existing
`ThreadReadService`; reading a diff does not start the orchestrator or provider.

The workspace patch family follows state, client-connection, extraction and
request-privacy in the normal package build. It splits original Context tags
from live VCS/known-workspace/PR owners, redirects imports to those same tags,
and extracts the original checkpoint reference function. PR URL parsing uses
the original pure source-control definitions, without importing forge drivers.
Type-only process/provider references stay out of the runtime graph. No source
implementation is copied into another session engine.

The two rollback behavior changes guard worktree recreation and stale Git-ref
deletion with `restoreFiles !== false`. Conversation-only rewind can still roll
back the provider and mark audit records stale. File restore retains the
original provider target, ready-checkpoint checks, workspace lease and shared
workspace refusal. It is not sandbox promotion. The patch does not add cleanup,
lock deletion, automatic retry or a replacement native conversation.

## Internal operations and admission requirements

`src/t3-session/workspace/service-operations.ts` constructs separate read, status
and mutation operation sets over the original required services. These are
internal calls, **not admitted executor implementation slots**. Nothing registers
them with the daemon, gateway, WebMCP or MCP. The original success/error schemas
remain enforced by `ExecutorT3ImplementationSlots` at the adapter boundary.

`contracts.ts` publishes method-correlated `WorkspaceInput` and `WorkspaceOutput`
types from the original descriptors. `requirements.ts` augments the canonical
`requestTargets` and `commandTargets` with repository, generated/explicit
worktree, nested diff/rename paths, original launch input, checkpoint range and
rewind/linked-PR resolution obligations. It preserves exact paths and IDs; an
obligation is never a path grant. In particular, `file.previousPath` and stacked
action `filePaths` cannot hide behind an authorized `cwd`.

Before activation the runtime/broker owners must supply all of the following:

1. Current selected-team/source/thread/project ownership and routing, including
   every affected resource. The ledger currently requires the owner for these
   RPCs. The catalog's read/control labels describe effects, not weaker grants.
2. Held writable/readable root and repository identity, including Git common
   directory, registered worktree membership, creation parent, replacement and
   symlink/reparse checks. `Workspace.Repository.VcsDriverRegistry`,
   `Workspace.KnownWorkspaces.KnownWorkspaces`, `Workspace.GitDriver.GitVcsDriver`,
  `Workspace.GitManager.GitManager` and Effect `FileSystem` remain required.
   Original known-workspace membership and `realPath` are not physical custody.
   Neither a caller callback nor T04's passive SQLite source lease supplies it.
3. Existing admitted native command creation, bounded output, exit/stop proof,
   credential routing and revocation for Git, forge CLIs and setup terminals.
   No ordinary Node filesystem/spawn layer may stand in for these owners.
4. Durable command admission and reconciliation across the whole operation,
   including post-Git PR linking and refresh. Reuse command and `actionId` on
   retry; bind both to the original actor, environment and body. A completed
   progress event is not proof of PR linking or total command completion.
5. Held authority through streams, nested effects and result filtering. A status
   refresh stays in the operation scope rather than a detached fiber. Stream
   cancellation is not evidence that a native process stopped or a mutation
   never occurred. Preserve uncertain outcomes for reconciliation. The stacked
   action adapter buffers at most 32 progress events without dropping them;
   the transport owner still supplies byte limits and bounded resource handles.

No production writer satisfying those requirements exists at this task's base.
The service adapter deliberately does not manufacture a lease, receipt or
capability-ready flag. Root/new/existing-worktree launch continues through
`orchestration.launchThread` and `Launch.ThreadLaunchService`; checkpoint
rewind and PR commands continue through `orchestration.dispatchCommand`.
T12 owns that dispatch and its queue, not a second implementation here.

## UI, WebMCP and MCP contract

All three surfaces use the same admitted operation. UI owns Dev/computer
Sessions → shared session → Git/Review, turn files, linked PR and launch
workspace doors. Tool owners register the following descriptors only after
their real prerequisite bindings are qualified.

| Canonical operation | Shape | Receipt and retry |
| --- | --- | --- |
| `orchestration.launchThread` | Finite original launch input/result | Original command ID, thread ID and initial message; root/existing/new strategy unchanged. |
| `orchestration.getWorktreeThreadIds` | Finite original worktree query | Repeatable read; filter every returned thread by current entitlement. |
| `review.getBranchCommits`, `review.getDiffPreview`, `review.getDiffFileContents` | Finite original inputs/results | Repeatable; preserve references, deferred patches, rename/delete, truncation and incompleteness. |
| `orchestration.getTurnDiff`, `orchestration.getFullThreadDiff` | Finite original thread/range inputs/results | Repeatable against exact source thread and checkpoint scope; no cross-thread run inference. |
| `subscribeVcsStatus`, `subscribeWorktreeSetup` | Original streams | Bounded resource handles; revoke and cancel through the shared stream owner. Setup cancellation is separate. |
| `worktreeSetup.cancel` | Finite `{threadId}` → `{cancelled}` | Durable command; `false` can mean setup is already uncancellable. No invented rollback. |
| `vcs.listRefs` | Finite original input/result | Ordinary listing repeatable; `refresh:true` additionally requires a command receipt in T15. The generic ledger's unconditional `none` still needs owner correction. |
| `vcs.refreshStatus` | Finite original status result | Durable command; a remote refresh can have effects. |
| `vcs.pull`, `vcs.createWorktree`, `vcs.removeWorktree`, `vcs.createRef`, `vcs.switchRef`, `vcs.init` | Finite original inputs/results | Durable command; unknown outcome cannot be retried as new work. `force` never grants deletion scope. |
| `git.resolvePullRequest` | Finite original reference/result | Repeatable owner read with admitted forge credentials. |
| `git.preparePullRequestThread` | Finite original input/result | Durable command; resulting worktree requires the same admitted repository. |
| `git.runStackedAction` | Original progress stream | Preserve `actionId` plus command receipt; bounded stream, no collected unbounded JSON. Created-PR link uses a stable thread/action-derived child command ID and the original link/refresh functions. |
| `orchestration.dispatchCommand`: `checkpoint.rollback` | Finite original command receipt | Preserve `scopeId`, `checkpointId`, `restoreFiles`; reconcile provider rollback separately from files. |
| `orchestration.dispatchCommand`: `thread.pull-request.link`, `.unlink`, `.watch` | Finite original command receipt | Preserve host/repository/number, source and watch state; internal sync variants stay internal. |

The original mobile doorway includes turn review, Git and linked PRs. Sent-message
conversation rewind is an original web/server operation, not an existing mobile
control. UI owners may expose a new Nessie phone control deliberately; this
adapter makes no mobile parity claim. Native Codex/Claude associations do not
merge identities or grant access to another source.

## Qualification

The bounded source author reads pinned Git objects and reproduces the manifest:

```powershell
$env:T3_WORKSPACE_SOURCE_REPOSITORY = 'C:/Users/ondre/Projects/t3code'
node --max-old-space-size=384 patches/t3-session/workspace/author.mjs
node --max-old-space-size=384 test/t3-session-workspace/inspect-source.mjs
```

Observed on Maxis with Node 24.19.0: 43 transformations authored; builtin source
inspection found 132 reachable workspace runtime modules, excluding the already
shared contract barrel, and passed the existing excluded-graph guard. This is
a bounded textual import probe, not the compiler/bundler closure. Builtin
TypeScript erasure and `git diff --check` are static evidence only.

Registered suites, **not run** under the source-only assignment:

```powershell
pnpm exec turbo run test:t3-session-workspace-source --root-turbo-json=scripts/turbo.public.json --concurrency=1
pnpm exec turbo run test:t3-session-workspace --root-turbo-json=scripts/turbo.public.json --concurrency=1
```

The first suite reproduces source transformations, checks drift refusal and
unchanged original service bodies, and checks the two rewind guards. The second
uses normal generated engine/contracts packages for requirements, IDs, receipt
conditions, original Context identities, diff parsing and review codecs. Its
Turbo build prerequisite must use this worktree's own dependencies and outputs.
The source suite has no package prerequisites; the runtime suite has no native
ACL, database or browser requirement. Compiler cap is 5120 MiB; test cap 512 MiB.

The new normal-package composition digest is
`298a116182e17626ab9b189f4e0c7ac394757569af68a3ce75e8194b8cfe642c`.
Previous package hashes and test results do not qualify this graph. Compiler,
runtime suites, actual admitted root/command/receipt flows, real provider
rollback, browser/phone and all three tool surfaces remain unverified. No live
repository was mutated for a fixture. No app, provider or server was launched.
