import type { SyncPage } from '@nessie/executor-protocol'

import type { FakePage } from '../folder-sync-fake-server.js'
import { editedText, freshLines, hashOf, type PersonContext } from './local-ops.js'
import type { SimServer } from './sim-server.js'

/**
 * Other writers in Nessie — a person in the editor or an agent: they create,
 * edit, rename, move and archive pages, publish one (it becomes a read-only
 * mirror), rename a space, or lose and regain access to one. Their writes are
 * entered in the same ledger as the computers'.
 */

const DOCUMENT_TITLES = ['Notes', 'Plan', 'plan', 'Roadmap', 'CON', 'Report', 'a:b', 'Trailing.', 'Café', 'Café']
const FILE_TITLES = ['logo.bin', 'notes.txt', 'Report.txt', 'aux.txt', 'data.bin', 'plan.md']
const FOLDER_TITLES = ['Docs', 'docs', 'Work', 'Archive', 'Café']
const SPACE_NAMES = ['Projects', 'Shared', 'Team Space', 'projects']

const encoder = new TextEncoder()

const isWithinPage = (server: SimServer, pageId: string, ancestorId: string): boolean => {
  for (let id: string | null = pageId; id !== null; id = server.pages.get(id)?.parentPageId ?? null) {
    if (id === ancestorId) return true
  }
  return false
}

const liveFolders = (server: SimServer): FakePage[] => server.livePages().filter((page) => page.kind === 'folder')

/** Where a new or moved page may go: a space root or a live folder. */
const placeFor = (person: PersonContext, server: SimServer, avoid?: FakePage) => {
  const folders = liveFolders(server).filter((folder) => !avoid || !isWithinPage(server, folder.id, avoid.id))
  const sameSpace = avoid ? folders.filter((folder) => folder.spaceId === avoid.spaceId) : folders
  const crossSpace = avoid !== undefined && server.spaces.length > 1 && person.rng.chance(0.15)
  const pool = crossSpace ? folders : sameSpace
  if (pool.length > 0 && person.rng.chance(0.6)) {
    const folder = person.rng.pick(pool)
    return { spaceId: folder.spaceId, parentPageId: folder.id }
  }
  const spaces = crossSpace || !avoid ? server.spaces : server.spaces.filter((space) => space.id === avoid.spaceId)
  return { spaceId: person.rng.pick(spaces.length > 0 ? spaces : server.spaces).id, parentPageId: null }
}

const textOf = (server: SimServer, page: FakePage): string => server.text(page) ?? ''

export const actorCreate = (person: PersonContext, server: SimServer, who: string): FakePage | null => {
  if (server.spaces.length === 0) return null
  const { rng } = person
  const kind = rng.weighted<SyncPage['kind']>([[5, 'document'], [4, 'file'], [2, 'folder'], [0.3, 'spreadsheet']])
  const place = placeFor(person, server)
  const title = kind === 'folder' ? rng.pick(FOLDER_TITLES) : kind === 'file' ? rng.pick(FILE_TITLES)
    : kind === 'spreadsheet' ? `Budget ${rng.int(3)}` : rng.pick(DOCUMENT_TITLES)
  const content = kind === 'folder' ? undefined : freshLines(person.token, rng.between(2, 5))
  const page = server.actor.create({ ...place, kind, title, ...(content ? { content } : {}) })
  if (content) person.ledger.write(hashOf(content), `${who} creates page`)
  person.log(`${who} creates ${kind} "${title}"`)
  return page
}

export const actorEdit = (person: PersonContext, server: SimServer, who: string, pageId?: string): void => {
  const candidates = server.livePages().filter((page) => page.kind !== 'folder' && server.head(page) !== null)
  const page = pageId ? server.pages.get(pageId) : candidates.length > 0 ? person.rng.pick(candidates) : undefined
  if (!page || page.status !== 'live' || page.kind === 'folder' || !server.head(page)) return
  const content = editedText(person.rng, textOf(server, page), person.token)
  server.actor.edit(page.id, encoder.encode(content))
  person.ledger.write(hashOf(content), `${who} edits page`)
  person.log(`${who} edits "${page.title}"`)
}

/** One random thing another writer does in Nessie. */
export const actorOperation = (person: PersonContext, server: SimServer): void => {
  const { rng } = person
  const who = rng.chance(0.5) ? 'agent' : 'colleague'
  const live = server.livePages()
  const op = live.length === 0 ? 'create' : rng.weighted<string>([
    [5, 'create'], [7, 'edit'], [2, 'rename'], [2, 'move'], [2, 'archive'], [0.3, 'publish'], [0.3, 'space'],
  ])
  if (op === 'create') {
    actorCreate(person, server, who)
    return
  }
  if (op === 'edit') {
    actorEdit(person, server, who)
    return
  }
  const page = rng.pick(live)
  if (op === 'rename') {
    const pool = page.kind === 'folder' ? FOLDER_TITLES : page.kind === 'file' ? FILE_TITLES : DOCUMENT_TITLES
    const title = rng.chance(0.2) ? page.title.toUpperCase() : rng.pick(pool)
    if (title === page.title || (page.kind === 'file' && !/\.[a-z]+$/u.test(title))) return
    server.actor.rename(page.id, title)
    person.log(`${who} renames "${page.title}"`)
  } else if (op === 'move') {
    const to = placeFor(person, server, page)
    if (to.parentPageId === page.parentPageId && to.spaceId === page.spaceId) return
    server.actor.move(page.id, to.parentPageId, to.spaceId)
    person.log(`${who} moves "${page.title}"`)
  } else if (op === 'archive') {
    server.actor.archive(page.id)
    person.log(`${who} archives "${page.title}"`)
  } else if (op === 'publish' && page.kind !== 'folder' && page.readOnlyReason === null) {
    page.readOnlyReason = 'published'
    page.revision += 1
    server.record({
      spaceId: page.spaceId, pageId: page.id, kind: 'page_published', versionId: null, revision: page.revision,
      parentPageId: page.parentPageId, title: page.title,
    }, null)
    person.log(`${who} publishes "${page.title}" (read-only now)`)
  } else if (op === 'space') {
    spaceOperation(person, server)
  }
}

/** C26 / C14: a space renamed, or the owner losing (and later regaining) access to one. */
const spaceOperation = (person: PersonContext, server: SimServer): void => {
  const { rng } = person
  const excluded = server.excludedSpaces
  if (excluded.length > 0 && rng.chance(0.6)) {
    const back = excluded.pop()!
    const space = revoked.get(back.spaceId)
    if (space) server.spaces.push(space)
    server.record({ spaceId: back.spaceId, pageId: null, kind: 'access_changed', versionId: null, revision: null,
      parentPageId: null, title: null }, null)
    person.log('access to a space comes back')
    return
  }
  const space = rng.pick(server.spaces)
  if (rng.chance(0.7) || server.spaces.length < 2) {
    space.name = rng.pick(SPACE_NAMES.filter((name) => name !== space.name))
    server.record({ spaceId: space.id, pageId: null, kind: 'space_updated', versionId: null, revision: null,
      parentPageId: null, title: null }, null)
    person.log(`space renamed to "${space.name}"`)
    return
  }
  server.spaces.splice(server.spaces.indexOf(space), 1)
  revoked.set(space.id, space)
  excluded.push({ spaceId: space.id, reason: 'restricted_space' })
  server.record({ spaceId: space.id, pageId: null, kind: 'access_changed', versionId: null, revision: null,
    parentPageId: null, title: null }, null)
  person.log(`access to space "${space.name}" revoked`)
}

const revoked = new Map<string, SimServer['spaces'][number]>()
