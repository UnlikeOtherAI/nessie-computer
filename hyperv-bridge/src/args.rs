//! The bridge's arguments, and the rule that turns a Linux guest's vsock port
//! into the GUID Windows addresses it by.
//!
//! Nothing here is Windows-specific, which is the point: it is the half that
//! decides what the sockets will be, so it is compiled and tested on Linux.

/// Which way connections flow.
///
/// Both of Nessie's guest channels — control and forced egress — are
/// guest-initiated, exactly as under Firecracker, so `GuestToHost` is the only
/// direction a session uses. `HostToGuest` exists for completeness and follows
/// Firecracker's own host-initiated shape, where the host dials and the guest
/// is listening.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Direction {
    GuestToHost,
    HostToGuest,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Arguments {
    pub direction: Direction,
    pub pipe: String,
    pub port: u32,
    pub vm_id: String,
}

pub const USAGE: &str = "usage: nessie-hyperv-bridge --vm-id <guid> --port <number> \
--pipe <\\\\.\\pipe\\name> --direction <guest-to-host|host-to-guest>";

/// Microsoft's VSOCK template GUID for a Linux guest:
/// `00000000-facb-11e6-bd58-64006a7986d3`. "To customize your Service GUID
/// simply change the first '00000000' to the port number desired. Ex:
/// '00000ac9' is port 2761." So a service GUID is not free to choose — it is
/// decided by the port the guest listens on, which is why nothing here takes a
/// GUID for the service.
pub const VSOCK_TEMPLATE_SUFFIX: &str = "-facb-11e6-bd58-64006a7986d3";

pub fn vsock_service_guid(port: u32) -> String {
    format!("{port:08x}{VSOCK_TEMPLATE_SUFFIX}")
}

fn valid_guid(value: &str) -> bool {
    let groups = [8usize, 4, 4, 4, 12];
    let parts: Vec<&str> = value.split('-').collect();
    parts.len() == groups.len()
        && parts
            .iter()
            .zip(groups)
            .all(|(part, length)| part.len() == length && part.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// A pipe name reaches the Win32 namespace, so it is checked rather than
/// trusted: local pipes only, no path traversal, no NUL.
fn valid_pipe(value: &str) -> bool {
    value.starts_with(r"\\.\pipe\")
        && value.len() > r"\\.\pipe\".len()
        && value.len() <= 256
        && !value[r"\\.\pipe\".len()..].contains('\\')
        && !value.contains('\0')
}

pub fn parse(argv: &[String]) -> Result<Arguments, &'static str> {
    let mut direction: Option<Direction> = None;
    let mut pipe: Option<String> = None;
    let mut port: Option<u32> = None;
    let mut vm_id: Option<String> = None;
    let mut index = 0usize;
    while index < argv.len() {
        let value = argv.get(index + 1).ok_or(USAGE)?;
        match argv[index].as_str() {
            "--vm-id" => {
                if !valid_guid(value) {
                    return Err(USAGE);
                }
                vm_id = Some(value.to_ascii_lowercase());
            }
            "--pipe" => {
                if !valid_pipe(value) {
                    return Err(USAGE);
                }
                pipe = Some(value.clone());
            }
            "--port" => {
                port = Some(value.parse::<u32>().map_err(|_| USAGE)?);
            }
            "--direction" => {
                direction = Some(match value.as_str() {
                    "guest-to-host" => Direction::GuestToHost,
                    "host-to-guest" => Direction::HostToGuest,
                    _ => return Err(USAGE),
                });
            }
            _ => return Err(USAGE),
        }
        index += 2;
    }
    Ok(Arguments {
        direction: direction.ok_or(USAGE)?,
        pipe: pipe.ok_or(USAGE)?,
        port: port.ok_or(USAGE)?,
        vm_id: vm_id.ok_or(USAGE)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    fn control() -> Vec<String> {
        argv(&[
            "--vm-id",
            "1D2B3C4A-5E6F-4A7B-8C9D-0E1F2A3B4C5D",
            "--port",
            "49152",
            "--pipe",
            r"\\.\pipe\nessie-hv-abc123-49152",
            "--direction",
            "guest-to-host",
        ])
    }

    #[test]
    fn a_service_guid_is_the_guest_port_in_the_vsock_template() {
        // Microsoft's own worked example: port 2761 is 0x00000ac9.
        assert_eq!(vsock_service_guid(2761), "00000ac9-facb-11e6-bd58-64006a7986d3");
        // Nessie's two guest channels, and the console beside them.
        assert_eq!(vsock_service_guid(49_152), "0000c000-facb-11e6-bd58-64006a7986d3");
        assert_eq!(vsock_service_guid(49_153), "0000c001-facb-11e6-bd58-64006a7986d3");
        assert_eq!(vsock_service_guid(0), "00000000-facb-11e6-bd58-64006a7986d3");
    }

    #[test]
    fn arguments_are_parsed_and_normalized() {
        let parsed = parse(&control()).expect("valid arguments");
        assert_eq!(parsed.direction, Direction::GuestToHost);
        assert_eq!(parsed.port, 49_152);
        assert_eq!(parsed.pipe, r"\\.\pipe\nessie-hv-abc123-49152");
        // Lower-cased so two spellings of one VM never look like two VMs.
        assert_eq!(parsed.vm_id, "1d2b3c4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d");
    }

    #[test]
    fn anything_that_is_not_a_local_pipe_or_a_guid_is_refused() {
        for replacement in [
            r"\\other\pipe\nessie",
            r"\\.\pipe\nessie\..\secret",
            r"\\.\pipe\",
            "nessie",
        ] {
            let mut arguments = control();
            arguments[5] = replacement.to_owned();
            assert!(parse(&arguments).is_err(), "{replacement} must be refused");
        }
        for replacement in ["", "not-a-guid", "1d2b3c4a5e6f4a7b8c9d0e1f2a3b4c5d"] {
            let mut arguments = control();
            arguments[1] = replacement.to_owned();
            assert!(parse(&arguments).is_err(), "{replacement} must be refused");
        }
    }

    #[test]
    fn an_incomplete_or_unknown_invocation_is_refused() {
        assert!(parse(&[]).is_err());
        assert!(parse(&argv(&["--vm-id"])).is_err());
        assert!(parse(&argv(&["--sideload", "x"])).is_err());
        let mut missing = control();
        missing.truncate(6);
        assert!(parse(&missing).is_err(), "a missing direction must be refused");
    }
}
