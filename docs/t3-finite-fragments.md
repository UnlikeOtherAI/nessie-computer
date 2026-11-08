# Finite reply fragments

`T3LaneFrame.fragment` carries consecutive pieces of one original encoded finite
reply on the existing signed daemon lane. It is mutually exclusive with `reply`.
`T3FiniteFragmentSchema` fixes version1, base64 encoding, full UTF-8 SHA256 digest,
total byte count, part count and index. Raw parts are at most1MiB; one original
reply and the process-held byte budget are each bounded at128MiB. No single
frame ceiling is raised. Oversize denial is explicit, never truncation.

Only retained finite reads may use this carrier. It grants neither subscriptions
nor command execution. Reassembly must preserve the exact original codec payload,
reconsume current authority before releasing the complete result, reject changed
digest/size/order/correlation and release all partial bytes on cancellation,
expiry or failure. The transport implementation and adversarial fixtures are
being authored; the ABI checkpoint alone is not working delivery evidence.
