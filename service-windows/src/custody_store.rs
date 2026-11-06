// The service remains the only writer. The native updater reads this same
// public journal while holding the cross-process machine admission barrier.
pub use nessie_windows_common::custody_store::*;
