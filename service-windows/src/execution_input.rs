//! Finite provider writes cannot acknowledge completion after authority expires.
use nessie_windows_common::{custody::REJECTED, execution::now_ms};
use std::{
    io::{ErrorKind, Write},
    time::Duration,
};

pub fn acknowledgement_wait(deadline: u64, now: u64) -> Duration {
    Duration::from_millis(deadline.saturating_sub(now).min(4000))
}

pub fn write(writer: &mut impl Write, bytes: &[u8], deadline: u64) -> Result<(), String> {
    write_with_clock(writer, bytes, deadline, now_ms)
}

fn write_with_clock(
    writer: &mut impl Write,
    mut bytes: &[u8],
    deadline: u64,
    mut now: impl FnMut() -> Result<u64, String>,
) -> Result<(), String> {
    while !bytes.is_empty() {
        if now()? >= deadline {
            return Err(REJECTED.into());
        }
        // Do not use write_all: every partial write and interrupted retry must
        // recheck authority before issuing another kernel write.
        match writer.write(&bytes[..bytes.len().min(16384)]) {
            Ok(0) => return Err(REJECTED.into()),
            Ok(count) => bytes = &bytes[count..],
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return Err(REJECTED.into()),
        }
    }
    if now()? >= deadline {
        return Err(REJECTED.into());
    }
    writer.flush().map_err(|_| REJECTED)?;
    if now()? >= deadline {
        return Err(REJECTED.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, io};

    struct DelayedWriter<'a> {
        clock: &'a Cell<u64>,
        write_delay: u64,
        flush_delay: u64,
        bytes: Vec<u8>,
        flushed: bool,
    }
    impl Write for DelayedWriter<'_> {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.clock.set(self.clock.get() + self.write_delay);
            self.bytes.push(bytes[0]);
            Ok(1)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.clock.set(self.clock.get() + self.flush_delay);
            self.flushed = true;
            Ok(())
        }
    }
    #[test]
    fn expired_partial_write_never_retries_remaining_bytes() {
        let clock = Cell::new(100);
        let mut writer = DelayedWriter {
            clock: &clock,
            write_delay: 10,
            flush_delay: 0,
            bytes: vec![],
            flushed: false,
        };
        assert!(write_with_clock(&mut writer, b"ab", 110, || Ok(clock.get())).is_err());
        assert_eq!(writer.bytes, b"a");
        assert!(!writer.flushed);
    }
    #[test]
    fn late_flush_is_unknown_even_when_all_bytes_were_written() {
        let clock = Cell::new(100);
        let mut writer = DelayedWriter {
            clock: &clock,
            write_delay: 0,
            flush_delay: 10,
            bytes: vec![],
            flushed: false,
        };
        assert!(write_with_clock(&mut writer, b"ab", 110, || Ok(clock.get())).is_err());
        assert_eq!(writer.bytes, b"ab");
        assert!(writer.flushed);
    }
    #[test]
    fn current_partial_writes_preserve_exact_bytes() {
        let clock = Cell::new(100);
        let mut writer = DelayedWriter {
            clock: &clock,
            write_delay: 1,
            flush_delay: 1,
            bytes: vec![],
            flushed: false,
        };
        assert!(write_with_clock(&mut writer, b"ab", 110, || Ok(clock.get())).is_ok());
        assert_eq!(writer.bytes, b"ab");
        assert!(writer.flushed);
    }
    #[test]
    fn wait_is_bounded_by_remaining_authority() {
        assert_eq!(acknowledgement_wait(110, 100), Duration::from_millis(10));
        assert_eq!(acknowledgement_wait(110, 110), Duration::ZERO);
        assert_eq!(acknowledgement_wait(110, 111), Duration::ZERO);
        assert_eq!(acknowledgement_wait(10000, 100), Duration::from_secs(4));
    }
}
