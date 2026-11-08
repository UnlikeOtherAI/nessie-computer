use std::{sync::atomic::{AtomicBool, AtomicU64, Ordering}, time::Instant};
use crate::protocol::NativeError;
use super::handles::fail;

/// A local resource lease can renew only after a fresh complete native check.
/// It does not renew historical-human authority. Expiry is irreversible.
pub struct LeaseClock { origin: Instant, renewed: AtomicU64, expired: AtomicBool }
impl LeaseClock {
    pub fn new() -> Self { Self { origin:Instant::now(), renewed:AtomicU64::new(0), expired:AtomicBool::new(false) } }
    pub fn check(&self) -> Result<(), NativeError> {
        if self.origin.elapsed().as_millis().saturating_sub(self.renewed.load(Ordering::Acquire) as u128) >= 60_000 {
            self.expired.store(true, Ordering::Release);
        }
        if self.expired.load(Ordering::Acquire) { Err(fail()) } else { Ok(()) }
    }
    pub fn renew_after_check(&self) -> Result<(), NativeError> {
        self.check()?;
        self.renewed.store(self.origin.elapsed().as_millis() as u64, Ordering::Release);
        self.check()
    }
    #[cfg(test)]
    pub fn expire(&self) { self.expired.store(true, Ordering::Release); }
}
