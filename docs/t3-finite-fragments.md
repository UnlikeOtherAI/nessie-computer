# Finite reply fragments

`T3LaneFrame.fragment` carries consecutive pieces of one original encoded finite
reply on the existing signed daemon lane. It is mutually exclusive with `reply`.
`T3FiniteFragmentSchema` fixes version 1, base64 encoding, full UTF-8 SHA256 digest,
total byte count, part count and index. Raw parts are at most 1 MiB; one original
reply and the process-held byte budget are each bounded at 128 MiB. No single
frame ceiling is raised. Oversize denial is explicit, never truncation.

Only retained finite reads may use this carrier. It grants neither subscriptions
nor command execution. Reassembly must preserve the exact original codec payload,
reconsume current authority before releasing the complete result, reject changed
digest/size/order/correlation and release all partial bytes on cancellation,
expiry or failure. `capacity_exceeded` is a Nessie transport error, not a changed
original T3 result. There is no truncated successful reply.

The runtime is pulled once and its exact original codec output serialized once.
Each part waits for the existing credit before sending; a lost response retries
the identical pending frame. Source/runtime ownership remains with the same
iterator. Cancellation and epoch change drop retained bytes; expiry cannot be
extended by credit. Backpressure waits rather than turning a partly sent finite
reply into a different result. Only the final fragment has `final:true`.

The backend keeps one encrypted pending frame in the existing relay and a small
`finiteTransfer` descriptor in its encrypted request spool. The descriptor pins
digest/count/size and the next index; ordinary replies cannot replace an active
fragment transfer. A process-local assembler reserves the declared bounded byte
count, checks every part and the final SHA256, then decodes the exact original
JSON through its existing codec. Current admission and result projection run
again before anything reaches the caller. No partial result reaches tools/UI,
and no second transcript, fragment database or source query is created.

The 128 MiB limits apply to retained serialized buffers, not the memory cost of
the final original typed object. Unpaged original results still materialize that
object. Existing admission/capture/selection/lease deadlines remain fixed; a
transfer that cannot finish within them fails, without renewing source access.

Transport credit/replay, Unicode boundaries, digest/order/final/count attacks,
buffer cleanup and real-PG spool ordering fixtures are authored and unrun under
SOURCE/TINY. The shared `test:t3-session-broker` gate covers them after parent
integration. Source parsing is not a successful large-catalog runtime journey.
