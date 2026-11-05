//! `nessie-hyperv-bridge` — the Hyper-V socket end of a guest session's
//! channels.
//!
//! Node has no `AF_HYPERV` and no way to acquire one, so this small process
//! sits between the guest's Hyper-V socket and a Windows named pipe the
//! executor daemon is already listening on. It carries the *transport* only:
//! the control channel's hello token and the egress tunnel's prelude are
//! checked by the daemon, exactly as they are under Firecracker, and this
//! process never reads a byte it relays.
//!
//! One process per channel, spawned by the daemon with an argv array — no
//! secret ever reaches it — and killed with the session.

mod args;
mod pump;

#[cfg(windows)]
mod hvsocket;
#[cfg(windows)]
mod pipe;

use std::process::ExitCode;

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let parsed = match args::parse(&argv) {
        Ok(parsed) => parsed,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::FAILURE;
        }
    };
    match run(parsed) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(windows)]
fn run(parsed: args::Arguments) -> Result<(), String> {
    use std::thread;

    hvsocket::start_winsock().map_err(|error| error.to_string())?;
    let service = args::vsock_service_guid(parsed.port);
    match parsed.direction {
        // Both of Nessie's channels: the guest dials, and every accepted
        // connection is handed to the pipe the daemon is listening on.
        args::Direction::GuestToHost => {
            let listener = hvsocket::HvListener::bind(&parsed.vm_id, &service)
                .map_err(|error| format!("cannot listen for the guest: {error}"))?;
            loop {
                let guest = match listener.accept() {
                    Ok(guest) => guest,
                    // A listener that has been torn down ends the process; the
                    // daemon stops this bridge with the session anyway.
                    Err(_) => return Ok(()),
                };
                let name = parsed.pipe.clone();
                thread::spawn(move || {
                    if let Ok(host) = pipe::connect(&name) {
                        let _ = pump::pump_bidirectional(guest, host);
                    }
                });
            }
        }
        // Nothing in a session uses this; it exists so the transport is
        // complete rather than half-implemented.
        args::Direction::HostToGuest => {
            let host = pipe::connect(&parsed.pipe).map_err(|error| error.to_string())?;
            let guest = hvsocket::connect(&parsed.vm_id, &service)
                .map_err(|error| format!("cannot reach the guest: {error}"))?;
            pump::pump_bidirectional(host, guest).map_err(|error| error.to_string())
        }
    }
}

/// The protocol half above is portable and is compiled and tested on Linux in
/// CI; the sockets are not, and saying so is better than a build that omits the
/// binary and leaves nobody to notice.
#[cfg(not(windows))]
fn run(_: args::Arguments) -> Result<(), String> {
    Err("nessie-hyperv-bridge runs on Windows: Hyper-V sockets exist nowhere else.".to_owned())
}
