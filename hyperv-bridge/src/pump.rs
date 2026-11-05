//! The byte pump.
//!
//! The bridge understands nothing about what crosses it. Both channels carry
//! their own authentication — the control channel's hello token, the egress
//! tunnel's 48-byte prelude — and both are checked by the daemon on the other
//! side of the pipe, exactly as they are under Firecracker. Reading the stream
//! here would only add a second place that could get it wrong.
//!
//! Portable on purpose: this is the half CI exercises on Linux, over ordinary
//! sockets, because a Windows named pipe and an `AF_HYPERV` socket are both
//! just a duplex `Read + Write` pair.

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::sync::mpsc;
use std::thread;

const BUFFER_BYTES: usize = 32 * 1024;

/// What both ends of the bridge have in common. `duplicate` is what lets one
/// connection be read on one thread and written on another; `shutdown` is what
/// unblocks the *other* thread once either direction has ended, so a finished
/// channel never leaves a reader waiting forever on a stream nobody will write
/// to again. Neither channel Nessie runs over this bridge half-closes.
pub trait DuplexStream: Read + Write + Send + Sized {
    fn duplicate(&self) -> io::Result<Self>;
    fn shutdown(&self);
}

impl DuplexStream for TcpStream {
    fn duplicate(&self) -> io::Result<Self> {
        self.try_clone()
    }
    fn shutdown(&self) {
        let _ = TcpStream::shutdown(self, std::net::Shutdown::Both);
    }
}

/// Copies until end of stream, then signals the far end. A read or write error
/// ends the copy rather than being reported: the far side of a bridged channel
/// going away is an ordinary session teardown, not a fault.
pub fn copy_stream<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    shutdown: impl FnOnce(),
) -> u64 {
    let mut buffer = vec![0u8; BUFFER_BYTES];
    let mut total = 0u64;
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        if writer.write_all(&buffer[..read]).is_err() {
            break;
        }
        total += read as u64;
    }
    let _ = writer.flush();
    shutdown();
    total
}

/// Runs both directions and returns as soon as either has ended, shutting both
/// streams so the other thread unblocks. Each direction gets its own thread
/// rather than a readiness loop: there is one connection per channel per
/// session, and a thread apiece costs less than the machinery to avoid one.
pub fn pump_bidirectional<A: DuplexStream + 'static, B: DuplexStream + 'static>(
    left: A,
    right: B,
) -> io::Result<()> {
    let mut left_reader = left.duplicate()?;
    let mut right_writer = right.duplicate()?;
    let mut right_reader = right.duplicate()?;
    let mut left_writer = left.duplicate()?;
    let (finished, ended) = mpsc::channel::<()>();
    let forward = finished.clone();
    thread::spawn(move || {
        copy_stream(&mut left_reader, &mut right_writer, || ());
        let _ = forward.send(());
    });
    thread::spawn(move || {
        copy_stream(&mut right_reader, &mut left_writer, || ());
        let _ = finished.send(());
    });
    let _ = ended.recv();
    left.shutdown();
    right.shutdown();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn a_stream_is_copied_verbatim_until_end_of_stream() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listen");
        let address = listener.local_addr().expect("address");
        let payload: Vec<u8> = (0..200_000u32).map(|value| (value % 251) as u8).collect();
        let expected = payload.clone();
        let sender = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).expect("connect");
            stream.write_all(&payload).expect("write");
            stream.shutdown(std::net::Shutdown::Write).expect("shutdown");
        });
        let (mut accepted, _) = listener.accept().expect("accept");
        let mut received = Vec::new();
        let copied = copy_stream(&mut accepted, &mut received, || ());
        sender.join().expect("sender");
        assert_eq!(copied, expected.len() as u64);
        assert_eq!(received, expected);
    }

    #[test]
    fn a_broken_writer_ends_the_copy_without_panicking() {
        struct Broken;
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"))
            }
            fn flush(&mut self) -> io::Result<()> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"))
            }
        }
        let mut source = &b"nessie"[..];
        let mut signalled = false;
        assert_eq!(copy_stream(&mut source, &mut Broken, || signalled = true), 0);
        assert!(signalled, "the far end must still be signalled");
    }

    /// The shape a session actually uses: bytes the guest wrote reach the
    /// daemon, and the daemon's answer reaches the guest, over one bridge.
    #[test]
    fn both_directions_are_relayed() {
        let guest_side = TcpListener::bind("127.0.0.1:0").expect("listen");
        let guest_address = guest_side.local_addr().expect("address");
        let guest = thread::spawn(move || {
            let (mut accepted, _) = guest_side.accept().expect("accept");
            let mut buffer = [0u8; 6];
            accepted.read_exact(&mut buffer).expect("read");
            assert_eq!(&buffer, b"nessie");
            accepted.write_all(b"guest!").expect("write");
        });
        let upstream = TcpStream::connect(guest_address).expect("connect");

        let daemon_side = TcpListener::bind("127.0.0.1:0").expect("listen");
        let daemon_address = daemon_side.local_addr().expect("address");
        let daemon = thread::spawn(move || {
            let mut stream = TcpStream::connect(daemon_address).expect("connect");
            stream.write_all(b"nessie").expect("write");
            let mut answer = [0u8; 6];
            stream.read_exact(&mut answer).expect("read");
            answer
        });
        let (accepted, _) = daemon_side.accept().expect("accept");
        pump_bidirectional(accepted, upstream).expect("pump");
        guest.join().expect("guest");
        assert_eq!(&daemon.join().expect("daemon"), b"guest!");
    }
}
