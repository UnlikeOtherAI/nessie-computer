use super::{pipe, resource::Resource, test_fixture::Fixture};
use serde_json::{json, Value};
use std::{fs::{File, OpenOptions}, io::{Read, Write}, thread, time::{Duration, Instant}};

fn connect(name: &str) -> File {
    let start = Instant::now();
    loop {
        match OpenOptions::new().read(true).write(true).open(name) {
            Ok(file) => return file,
            Err(error) => {
                assert!(start.elapsed() < Duration::from_secs(5), "pipe start: {error}");
                thread::sleep(Duration::from_millis(10));
            }
        }
    }
}
fn send(file: &mut File, key: &[u8], sequence: u64, message: Value, tamper: bool) {
    let body = message.to_string();
    let frame = json!({"sequence":sequence,"mac":pipe::mac(key,"request",sequence,&body),
        "body":if tamper {"{\"op\":\"close\"}"} else {&body}}).to_string();
    file.write_all(&(frame.len() as u32).to_le_bytes()).unwrap();
    file.write_all(frame.as_bytes()).unwrap();
}
fn receive(file: &mut File, key: &[u8], sequence: u64) -> Value {
    let mut size = [0;4]; file.read_exact(&mut size).unwrap();
    let mut bytes = vec![0; u32::from_le_bytes(size) as usize];
    assert!(bytes.len() < 16*1024*1024); file.read_exact(&mut bytes).unwrap();
    let frame: Value = serde_json::from_slice(&bytes).unwrap();
    let body = frame["body"].as_str().unwrap();
    assert_eq!(frame["sequence"], sequence);
    assert_eq!(frame["mac"], pipe::mac(key,"response",sequence,body));
    serde_json::from_str(body).unwrap()
}
fn start(request: Value) -> thread::JoinHandle<Result<(), crate::protocol::NativeError>> {
    thread::spawn(move || pipe::serve(&request, Resource::open(&request)?))
}

#[test]
fn real_private_pipe_serves_the_held_database_and_rejects_replay() {
    let fixture = Fixture::new(false);
    let nonce = format!("{:064x}", std::process::id());
    let key = [11_u8;32];
    let mut request = fixture.request.clone();
    request["nonce"] = json!(nonce); request["secret"] = json!(super::resource::hex(&key));
    request["parentPid"] = json!(std::process::id());
    let thread = start(request);
    let mut file = connect(&format!(r"\\.\pipe\nessie-t3-source-{nonce}"));
    send(&mut file,&key,1,json!({"op":"describe"}),false);
    assert_eq!(receive(&mut file,&key,1)["value"]["source"]["databaseRole"],"sole-legacy");
    send(&mut file,&key,2,json!({"op":"query","query":"migrations"}),false);
    let id = receive(&mut file,&key,2)["value"]["statement"].clone();
    send(&mut file,&key,3,json!({"op":"next","statement":id}),false);
    assert_eq!(receive(&mut file,&key,3)["value"]["row"]["migration_id"],1);
    send(&mut file,&key,3,json!({"op":"describe"}),false);
    let mut byte = [0]; assert!(file.read(&mut byte).map_or(true, |read| read == 0));
    assert!(thread.join().unwrap().is_err());
}

#[test]
fn pipe_rejects_changed_bytes_wrong_key_and_wrong_client_process() {
    for scenario in 0..3 {
        let fixture = Fixture::new(false);
        let nonce = format!("{:056x}{:08x}", std::process::id(), 100+scenario);
        let key = [12_u8;32];
        let mut request = fixture.request.clone();
        request["nonce"] = json!(nonce); request["secret"] = json!(super::resource::hex(&key));
        request["parentPid"] = json!(if scenario == 2 { u32::MAX } else { std::process::id() });
        let thread = start(request);
        let mut file = connect(&format!(r"\\.\pipe\nessie-t3-source-{nonce}"));
        if scenario != 2 { send(&mut file, if scenario == 1 {&[13_u8;32]} else {&key},1,json!({"op":"describe"}),scenario == 0); }
        let mut byte = [0]; assert!(file.read(&mut byte).map_or(true, |read| read == 0));
        assert!(thread.join().unwrap().is_err());
    }
}
