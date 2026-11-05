// FolderSyncConsoleState fixtures for the Sync tab, one per engine state the
// console can be in, plus the two dishonest reports the status line must
// correct (A12.12): "up to date" while files are pending or a conflict is open.
const ids = {
  copy: '7d1c5d8e-2f4b-4c3a-9a51-0b6f0d2a1c01',
  quarantine: '7d1c5d8e-2f4b-4c3a-9a51-0b6f0d2a1c02',
  info: '7d1c5d8e-2f4b-4c3a-9a51-0b6f0d2a1c03',
  error: '7d1c5d8e-2f4b-4c3a-9a51-0b6f0d2a1c04',
  batch: '5a0e6b2c-8d7f-4e19-b3c2-6f1d9e4a7b10',
}
export const syncIds = ids

const counts = (overrides = {}) => ({ entries: 128, pendingUploads: 0, pendingDownloads: 0, openConflicts: 0, waiting: 0,
  errors: 0, heldDeletes: 0, notSynced: 0, ...overrides })

const conflicts = [
  { clientConflictId: ids.copy, kind: 'conflicted_copy', reason: 'edited_on_both_sides',
    relPath: 'Product/Plans/2026 roadmap — quarterly planning notes for the platform team.md', pageId: null,
    copy: { relPath: 'Product/Plans/2026 roadmap (conflicted copy).md', pageId: null }, occurredAt: '2026-11-03T09:12:00.000Z' },
  { clientConflictId: ids.quarantine, kind: 'quarantined', reason: 'read_only_document_formatting',
    relPath: 'Handbook/Onboarding.md', pageId: null, copy: { relPath: 'Handbook/Onboarding (my edit).md', pageId: null },
    occurredAt: '2026-11-03T09:10:00.000Z' },
  { clientConflictId: ids.info, kind: 'info', reason: 'renamed_in_nessie', relPath: 'Notes/Standup.md', pageId: null,
    copy: null, occurredAt: '2026-11-03T09:05:00.000Z' },
  { clientConflictId: ids.error, kind: 'error', reason: 'file_in_use', relPath: 'Finance/Budget.xlsx', pageId: null,
    copy: null, occurredAt: '2026-11-03T09:01:00.000Z' },
]

const held = { batchId: ids.batch, count: 23, reason: 'mass_delete',
  sample: ['Product/Specs/Search.md', 'Product/Specs/Billing.md', 'Product/Specs/Sharing.md'] }

export const syncState = (host, overrides = {}) => {
  const root = host === 'windows' ? 'C:\\Users\\person\\Documents\\Nessie' : '/Users/person/Documents/Nessie'
  return {
    executorId: 'team-0', teamLabel: 'Platform', enabled: true, paused: false, root, defaultRoot: root,
    trashPath: host === 'windows' ? 'C:\\Users\\person\\.local\\state\\nessie-executor\\team-0\\folder-sync\\trash'
      : '/Users/person/Library/Application Support/Nessie Executor/executor/folder-sync/trash',
    state: 'up_to_date', serverStatus: 'live',
    manageUrl: 'https://unlikeotherai.nessie.works/platform/computers/team-0?tab=sync',
    counts: counts(), activity: { uploading: 0, downloading: 0 }, lastReconcileAt: '2026-11-03T10:00:00.000Z',
    conflicts: [], heldDeletes: null, notSynced: [], ...overrides,
  }
}

/** [name, overrides, the status key the line must show, the counted number for `syncing`]. */
export const syncCases = (host) => [
  ['off', { enabled: false, state: 'off', root: null, serverStatus: null, manageUrl: null }, 'off'],
  ['starting', { state: 'starting', serverStatus: null }, 'starting'],
  ['waiting', { state: 'waiting_for_confirmation', serverStatus: 'requested' }, 'waiting_for_confirmation'],
  ['syncing', { state: 'syncing', counts: counts({ pendingUploads: 7, pendingDownloads: 5 }),
    activity: { uploading: 2, downloading: 3 } }, 'syncing', 12],
  ['syncing-one', { state: 'syncing', counts: counts({ pendingDownloads: 1 }) }, 'syncing', 1],
  ['up-to-date', {}, 'up_to_date'],
  ['claims-up-to-date-while-pending', { counts: counts({ pendingUploads: 3 }) }, 'syncing', 3],
  ['claims-up-to-date-with-conflict', { counts: counts({ openConflicts: 1 }), conflicts: [conflicts[0]] }, 'needs_attention'],
  ['paused', { paused: true, state: 'paused', serverStatus: 'paused' }, 'paused'],
  ['root-missing', { state: 'root_missing' }, 'root_missing'],
  ['disk-full', { state: 'disk_full', counts: counts({ pendingDownloads: 40 }) }, 'disk_full'],
  ['needs-attention', { state: 'needs_attention', heldDeletes: held,
    counts: counts({ openConflicts: 4, heldDeletes: 23, errors: 1 }), conflicts }, 'needs_attention'],
  ['reauthorize', { state: 'needs_reauthorization', serverStatus: 'needs_reauthorization' }, 'needs_reauthorization'],
  ['offline', { state: 'offline', counts: counts({ pendingUploads: 2 }) }, 'offline'],
  ['not-private', { enabled: false, state: 'not_private', root: null, serverStatus: null, manageUrl: null }, 'not_private'],
].map(([name, overrides, key, count]) => ({ name, state: syncState(host, overrides), key, count }))

export const syncTrash = [
  { entryId: '2026-11-02/Product/Old plan.md', relPath: 'Product/Old plan.md', deletedAt: '2026-11-02T15:00:00.000Z' },
  { entryId: '2026-10-20/Notes/Retro.md', relPath: 'Notes/Retro.md', deletedAt: '2026-10-20T08:30:00.000Z' },
]

/** The page-side host for the sync commands: answers like the CLI would, and records nothing beyond `window.calls`. */
export const installSyncHost = (context, fixture, trash) => context.addInitScript(({ fixture, trash }) => {
  window.syncFixture = fixture
  window.syncTrash = trash
  const clone = () => JSON.parse(JSON.stringify(window.syncFixture))
  const applied = () => ({ outcome: 'applied', state: clone() })
  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
  window.syncHost = async (command, args) => {
    const state = window.syncFixture
    if (command === 'executor_sync_status') {
      if (window.syncStatusFails) throw new Error(window.syncStatusFails)
      return clone()
    }
    if (command === 'executor_sync_pick_folder') return window.syncPicked ?? null
    if (['executor_open_path', 'executor_sync_open_nessie'].includes(command)) return null
    if (window.syncRefuse) {
      const reason = window.syncRefuse
      window.syncRefuse = null
      return { outcome: 'refused', reason }
    }
    if (command === 'executor_sync_configure') {
      await wait(window.syncConfigureDelay ?? 0)
      const input = args.command
      if (input.command === 'configure') {
        if (window.syncExistingFiles && !input.acceptExistingFiles) return { outcome: 'confirm_existing_files', fileCount: window.syncExistingFiles }
        Object.assign(state, { root: input.root, enabled: input.enabled,
          state: input.enabled ? 'waiting_for_confirmation' : 'off', serverStatus: input.enabled ? 'requested' : null,
          manageUrl: input.enabled ? 'https://unlikeotherai.nessie.works/platform/computers/team-0?tab=sync' : state.manageUrl })
      }
      if (input.command === 'pause') Object.assign(state, { paused: input.paused, state: input.paused ? 'paused' : 'up_to_date' })
      if (input.command === 'held_deletes') {
        state.heldDeletes = null
        state.counts.heldDeletes = 0
      }
      return applied()
    }
    if (command === 'executor_sync_resolve') {
      state.conflicts = state.conflicts.filter((row) => row.clientConflictId !== args.clientConflictId)
      state.counts.openConflicts = state.conflicts.length
      return applied()
    }
    if (command === 'executor_sync_trash_list') return { entries: window.syncTrash }
    if (command === 'executor_sync_trash_restore') {
      window.syncTrash = window.syncTrash.filter((entry) => entry.entryId !== args.entryId)
      return applied()
    }
    throw new Error(`Unexpected sync command ${command}`)
  }
}, { fixture, trash })
