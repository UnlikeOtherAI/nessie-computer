//! Fixed actual-token storage. Never accepts a filesystem path from the graph.
use super::{
    consent_state::random_id,
    execution_resource::service,
    handles::{chain, fail, wide, Held, Watch},
};
use crate::protocol::NativeError;
use nessie_windows_common::{
    execution_destination::{self as layout, FileReceipt, Receipt},
    execution_resource::{Object, Receipt as ResourceReceipt, Request},
};
use std::{
    collections::HashMap,
    fs::File,
    os::windows::io::{AsRawHandle, FromRawHandle},
    path::{Path, PathBuf},
};
use windows_sys::Win32::{
    Foundation::{LocalFree, INVALID_HANDLE_VALUE},
    Security::SECURITY_ATTRIBUTES,
    Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_FLAG_OPEN_REPARSE_POINT, OPEN_ALWAYS,
    },
};

pub(super) struct Destination {
    pub receipt: Receipt,
    directory: Vec<Held>,
    writer: Held,
    watches: Vec<Watch>,
    files: HashMap<String, (Held, FileReceipt)>,
}
fn object(held: &Held, directory: bool) -> Object {
    Object {
        handle: held.file.as_raw_handle() as usize as u64,
        identity: held.identity.clone(),
        kind: if directory { "directory" } else { "database" }.into(),
        private: true,
    }
}
fn single_file(held: &Held) -> Result<PathBuf, NativeError> {
    held.recheck()?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(held.file.as_raw_handle(), &mut info) } == 0
        || info.nNumberOfLinks != 1
    {
        return Err(fail());
    }
    held.path()
}
fn writer(path: &Path) -> Result<Held, NativeError> {
    let descriptor = crate::state_security::private_pipe_descriptor()?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    // OPEN_ALWAYS never truncates/removes the persistent lock artifact. A real
    // read/write handle and zero sharing exclude other writers and deletion.
    let handle = unsafe {
        CreateFileW(
            wide(path).as_ptr(),
            0xC002_0080,
            0,
            &attributes,
            OPEN_ALWAYS,
            FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    unsafe {
        LocalFree(descriptor);
    }
    if handle == INVALID_HANDLE_VALUE {
        return Err(fail());
    }
    let held = Held::from_file(unsafe { File::from_raw_handle(handle) }, false, true)?;
    single_file(&held)?;
    Ok(held)
}
fn open_objects(path: &Path) -> Result<(Vec<Held>, Held, Vec<Watch>), NativeError> {
    let directory = chain(path)?;
    let path = directory.last().ok_or_else(fail)?.path()?;
    let writer = writer(&path.join(layout::WRITER_FILE))?;
    let mut watches = directory
        .iter()
        .map(|part| Watch::security(&part.path()?))
        .collect::<Result<Vec<_>, _>>()?;
    watches.push(Watch::metadata(&path)?);
    Ok((directory, writer, watches))
}
impl Destination {
    pub fn open(resource: &ResourceReceipt) -> Result<Self, NativeError> {
        let personal = crate::personal_state_context::protected_root()?;
        let profile = personal
            .parent()
            .and_then(|p| p.parent())
            .ok_or_else(fail)?;
        let path = layout::directory(
            profile,
            &resource.evidence.source.executor_id,
            &resource.evidence.source.physical_root_key,
        )
        .map_err(|_| fail())?;
        Self::from_directory(resource, &path)
    }
    fn from_directory(resource: &ResourceReceipt, path: &Path) -> Result<Self, NativeError> {
        let (directory, writer, watches) = open_objects(path)?;
        let last = directory.last().ok_or_else(fail)?;
        let registered = service(Request::OpenDestination {
            executor_id: resource.evidence.source.executor_id.clone(),
            resource_id: resource.resource_id.clone(),
            nonce: random_id()?,
            directory: object(last, true),
            writer: object(&writer, false),
            watches: watches.iter().map(Watch::raw).collect(),
        })?;
        let receipt: Receipt = serde_json::from_value(registered).map_err(|_| fail())?;
        if receipt.version != 1
            || receipt.resource_id != resource.resource_id
            || receipt.resource_generation != resource.resource_generation
            || receipt.directory_identity != last.identity
            || receipt.writer_identity != writer.identity
            || receipt.runtime_generation.is_empty()
        {
            return Err(fail());
        }
        let result = Self {
            receipt,
            directory,
            writer,
            watches,
            files: HashMap::new(),
        };
        result.recheck()?;
        Ok(result)
    }
    pub fn directory(&self) -> Result<PathBuf, NativeError> {
        self.recheck()?;
        self.directory.last().ok_or_else(fail)?.path()
    }
    pub fn hold_file(
        &mut self,
        resource: &ResourceReceipt,
        reference: &str,
    ) -> Result<FileReceipt, NativeError> {
        self.recheck()?;
        if let Some((_, receipt)) = self.files.get(reference) {
            return Ok(receipt.clone());
        }
        if self.files.len() >= 65 {
            return Err(fail());
        }
        let name = layout::filename(reference).map_err(|_| fail())?;
        let file = Held::open(&self.directory()?.join(name), false, true, true)?;
        single_file(&file)?;
        let answer = service(Request::HoldDestinationFile {
            executor_id: resource.evidence.source.executor_id.clone(),
            resource_id: resource.resource_id.clone(),
            reference: reference.into(),
            file: object(&file, false),
        })?;
        let receipt: FileReceipt = serde_json::from_value(answer).map_err(|_| fail())?;
        if receipt.version != 1
            || receipt.reference != reference
            || receipt.runtime_generation != self.receipt.runtime_generation
            || receipt.database_identity != file.identity
        {
            return Err(fail());
        }
        self.files.insert(reference.into(), (file, receipt.clone()));
        self.recheck()?;
        Ok(receipt)
    }
    pub fn recheck(&self) -> Result<(), NativeError> {
        for watch in &self.watches {
            watch.recheck()?;
        }
        for part in &self.directory {
            part.recheck_object()?;
        }
        let directory = self.directory.last().ok_or_else(fail)?;
        directory.recheck()?;
        let path = directory.path()?;
        if single_file(&self.writer)? != path.join(layout::WRITER_FILE) {
            return Err(fail());
        }
        for (reference, (file, _)) in &self.files {
            if single_file(file)? != path.join(layout::filename(reference).map_err(|_| fail())?) {
                return Err(fail());
            }
        }
        for watch in &self.watches {
            watch.recheck()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_fixture::{directory, secure, Writer};
    use super::*;
    use std::fs;

    // Kernel-object component seam only; no authenticated service/receipt or
    // native authority is substituted. Production always registers open_objects.
    fn local(path: &Path) -> Destination {
        let (directory, writer, watches) = open_objects(path).unwrap();
        Destination {
            receipt: Receipt {
                version: 1,
                resource_id: "component".into(),
                resource_generation: "component".into(),
                runtime_generation: "component".into(),
                directory_identity: directory.last().unwrap().identity.clone(),
                writer_identity: writer.identity.clone(),
            },
            directory,
            writer,
            watches,
            files: HashMap::new(),
        }
    }
    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        directory(root.path());
        let path = root.path().join("destination");
        directory(&path);
        (root, path)
    }
    #[test]
    fn execution_destination_writer_and_ancestor_names_are_exclusive_until_last_handle_closes() {
        let (root, path) = fixture();
        let held = local(&path);
        held.recheck().unwrap();
        assert!(open_objects(&path).is_err());
        assert!(fs::rename(&path, root.path().join("replaced")).is_err());
        assert!(fs::remove_file(path.join(layout::WRITER_FILE)).is_err());
        let duplicate = held.writer.file.try_clone().unwrap();
        drop(held);
        assert!(writer(&path.join(layout::WRITER_FILE)).is_err());
        drop(duplicate);
        assert!(writer(&path.join(layout::WRITER_FILE)).is_ok());
        assert!(path.join(layout::WRITER_FILE).exists());
    }
    #[test]
    fn execution_destination_pins_allow_actual_sqlite_writes_but_deny_main_database_replacement() {
        let (root, path) = fixture();
        let database = path.join("capture-journal.sqlite");
        let mut held = local(&path);
        // The test runner may be elevated; the production graph is not. Stamp
        // this fixture's actual user at creation, before SQLite opens it, rather
        // than weakening strict handle ownership or resetting sticky watches.
        drop(writer(&database).unwrap());
        held.recheck()
            .expect("private database creation invalidated destination");
        let sql = Writer::open(&database);
        sql.exec("PRAGMA journal_mode=WAL; CREATE TABLE pending(value TEXT); INSERT INTO pending VALUES ('before')");
        held.recheck()
            .expect("SQLite initialization invalidated destination");
        let file = Held::open(
            &held.directory().unwrap().join("capture-journal.sqlite"),
            false,
            true,
            true,
        )
        .unwrap();
        single_file(&file).unwrap();
        held.files.insert(
            "journal".into(),
            (
                file,
                FileReceipt {
                    version: 1,
                    runtime_generation: "component".into(),
                    reference: "journal".into(),
                    database_identity: "unused-component-metadata".into(),
                },
            ),
        );
        sql.exec("INSERT INTO pending VALUES ('after'); PRAGMA wal_checkpoint(TRUNCATE)");
        held.recheck().unwrap();
        assert!(fs::rename(&database, root.path().join("swapped.sqlite")).is_err());
        assert!(fs::remove_file(&database).is_err());
        held.recheck().unwrap();
        drop(sql);
        held.recheck().unwrap();
    }
    #[test]
    fn execution_destination_rejects_existing_writer_handles_and_hard_link_aliases() {
        let (root, path) = fixture();
        let lock = path.join(layout::WRITER_FILE);
        fs::write(&lock, []).unwrap();
        secure(&lock);
        let preexisting = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lock)
            .unwrap();
        assert!(open_objects(&path).is_err());
        drop(preexisting);
        let database = path.join("capture-journal.sqlite");
        fs::write(&database, []).unwrap();
        secure(&database);
        fs::hard_link(&database, root.path().join("alias")).unwrap();
        let held = Held::open(&database, false, true, true).unwrap();
        assert!(single_file(&held).is_err());
    }
}
