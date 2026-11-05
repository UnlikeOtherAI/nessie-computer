// The local console is the same document on macOS and Windows. Only this
// process-local transport differs. Neither host permits remote navigation.
// A host event hands its handler the event's payload — a Tauri event's
// `payload`, a macOS CustomEvent's `detail` — or null when it carries none.
window.executorNative = window.__TAURI__ ? {
  platform: 'windows',
  invoke: (command, args) => window.__TAURI__.core.invoke(command === 'executor_describe' ? 'executor_console_describe' : command, args),
  listen: (event, handler) => window.__TAURI__.event.listen(event, (message) => handler(message?.payload ?? null)),
} : {
  platform: 'macos',
  invoke: (command, args = {}) => window.webkit.messageHandlers.executor.postMessage({ command, args }),
  listen: (event, handler) => {
    const receive = (message) => handler(message.detail ?? null)
    window.addEventListener(event, receive)
    return Promise.resolve(() => window.removeEventListener(event, receive))
  },
}

// Folder sync. The page names a team, a choice and public identifiers; the
// host reads every path it opens from the CLI's own status, and every change
// reaches `nessie-executor sync` as JSON on standard input, never on argv.
Object.assign(window.executorNative, {
  /** The native folder picker; the chosen path, or null. */
  syncPickFolder: () => window.executorNative.invoke('executor_sync_pick_folder'),
  /** `FolderSyncConsoleState` for one team. */
  syncStatus: (executorId) => window.executorNative.invoke('executor_sync_status', { executorId }),
  /** A `configure`, `pause` or `held_deletes` command; answers `FolderSyncConsoleCommandResult`. */
  syncConfigure: (executorId, command) => window.executorNative.invoke('executor_sync_configure', { executorId, command }),
  /** Keep mine, Keep Nessie's or dismiss one open conflict; answers `FolderSyncConsoleCommandResult`. */
  syncResolve: (executorId, clientConflictId, resolution) => window.executorNative.invoke('executor_sync_resolve',
    { executorId, clientConflictId, resolution }),
  /** Opens the sync folder (`root`) or Deleted files (`trash`), or shows a listed conflict's file (`file`). */
  syncOpenPath: (executorId, location, relPath) => window.executorNative.invoke('executor_open_path',
    { executorId, location, ...(relPath ? { relPath } : {}) }),
  /** Opens this computer's Sync tab in Nessie, at the address the handshake gave. */
  syncOpenNessie: (executorId) => window.executorNative.invoke('executor_sync_open_nessie', { executorId }),
  /** The local trash: `{ entries: [{ entryId, relPath, deletedAt }] }`. */
  syncTrashList: (executorId) => window.executorNative.invoke('executor_sync_trash_list', { executorId }),
  /** Puts one trash entry back in the folder; answers `FolderSyncConsoleCommandResult`. */
  syncTrashRestore: (executorId, entryId) => window.executorNative.invoke('executor_sync_trash_restore', { executorId, entryId }),
})
