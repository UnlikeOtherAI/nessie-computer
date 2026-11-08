# Session operation tool schemas

The `@nessie/executor-protocol/t3-session` tool inventory projects named operations
from the original T3 RPC descriptors and public command union. It registers no
runtime or MCP server and grants no authority. Source is T3 even when a turn's
provider is Codex or Claude; native applications need their own operation owners.

`executorT3ToolOperations()` returns original method/command identity, authority,
finite/stream kind, receipt policy and original input codec. There is no generic
command-dispatch tool. Internal commands and sealed request answers are omitted.
`executorT3ToolInputSchema()` emits original JSON schema definitions.
`decodeExecutorT3ToolInput()` checks that schema and the existing input policy,
retains opaque IDs and command IDs, and refuses caller-supplied broker fences.
Codec errors never echo supplied values. Parsing is not source or execution
admission; the canonical gateway owns that boundary.

`executorT3RpcOperationPolicy(method)` is the shared input-policy descriptor.
`executorT3RpcInputPolicy(decodedRequest)` accepts the correlated original
`{method, input}` and resolves the current call's policy. Neither helper grants
access. They carry the gateway policy from private `c614d8e635`: `vcs.listRefs`
retains owner authority and advertises `receipt: conditional-refresh`, the exact
`refresh === true` input policy and `annotations.readOnlyHint: false`. False or
omitted refresh resolves to read admission and no receipt; only true resolves to
mutation admission with a durable-command-or-delivery receipt. The original
codec rejects string booleans. Tool schema and decoding require `commandId` for
that mutation without requiring it for reads. Retry retains the same original ID.
Gateway and browser owners consume these exports after parent integration;
they must not maintain independent versions of the condition.

`executorT3HistoryTools()` preserves the five original HTTP history descriptors
separately. Authentication/protocol headers belong to the gateway. These are
schema inventories, not history implementations or replacement session DTOs.

The fixtures in `test/t3-session-contracts/tools.test.ts` are included by the
existing protocol `test:t3-session-contracts` glob. They are authored but unrun
at this checkpoint. Qualification must build the actual source/protocol packages
and run that Turbo gate in an allocated serial lane. No installed native,
provider, MCP wire, stream/resource or ownership qualification follows from
schema tests.
