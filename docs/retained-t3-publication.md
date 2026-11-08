# Retained catalog publication

Status: source implementation in progress; no runtime qualification. The producer
uses T07's `createT3CatalogPublicationTransport` and original captured V2 rows.
It sends bounded metadata pages with immutable counts, digest and original source
order. It never sends a local stage reference for the server to dereference.

`createRetainedCatalogPublicationPort` implements `publishLocalCapture` over the
exact journal generation and explicit publication authority. Publication consent
is separate from catalog read consent. Only an explicit whole-environment grant
can emit source completion; a thread selection emits selection completion.

The first enumeration computes counts and a digest; a second enumeration in the
same destination transaction sends at most 128 entries per page. T07 reconciles
repeated identical pages. Timeout or transport rejection leaves staging and
receipts for an explicit retry. No session-ID sort, 5,000-row limit, transcript
copy or native association inference is used.

Parent integration of the signed transport and real import owner is required.
The current follow-up is adapting the producer to `withRetainedImportLocally`'s
held database/source callback, including physical keepalive during waits. It
must not reopen the source or use that callback after it returns. Mapping/group
semantics are being confirmed directly with T07 before final handoff.

Authored fixtures cover bounded enumeration beyond 5,000 identities, original
SQLite Unicode ties, exact subsets, empty selections and reference substitution.
No fixture, compiler, database, native process or browser has run in this tranche.
