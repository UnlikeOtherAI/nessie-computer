# Retained original-owner admission

`src/t3-session/ownership/original-owner.ts` exports
`unprovenRetainedOriginalOwnerPort`, a refusal implementation of the existing
`RetainedOriginalOwnerPort`. It always throws
`retained_original_owner_unproven` before calling either supplied function.
It grants no history, control, custody, capture completion or tool capability.

The original source at `25bf84ab07f53f141c20239c63e383823a9d5ea0` does not
record an authenticated original-human/thread relation:

- `OrchestrationV2Actor` is the literal `user`, `agent` or `system`; `createdBy`
  is not a subject reference.
- `persistence/Migrations/020_AuthAccessManagement.ts` records environment auth
  subjects and sessions, without a thread-ownership relation or a UOA binding.
- `055_OrchestrationV2.ts` records application/provider identities;
  `owner_node_id` refers to an orchestration node, not a human.

The refusal port is not the missing production continuity producer. Real
historical read admission still requires independently verified original-human
evidence, current same-person selected-team admission, exact physical producer
function recognition, original-ownership generation/revocation fencing and an
absolute read lifetime of at most 60 seconds. Neither file possession, current
login, computer administration, a new capture nor a later managed-start receipt
establishes those facts. No callback-based trust factory is provided.

An explicit prospective import/read decision would be a separate canonical
authority kind with historical ownership left unknown. It must not be relabeled
as original ownership, or grant provider execution/custody. The private control
plane owns that product decision and its selected-team grant service; this
public package adds no identity, membership or grant store.

The source-only refusal fixtures are registered in
`test:t3-session-import-source`, using the existing builtin type-erasure harness.
They are authored and unrun at this checkpoint. Positive physical/human
binding, actual retained-history reads and installed/manual acceptance remain
blocked and unclaimed. See [the capture contract](retained-t3-capture.md).
