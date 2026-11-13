//! Shared OS-authenticated framing; retained issuer domain remains separate.
pub use crate::protected_pipe::{instance,connect,client,alive,write,Reader};
pub const PIPE:&str=r"\\.\pipe\NessieT3SourceIssuer";
