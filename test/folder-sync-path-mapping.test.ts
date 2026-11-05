import assert from 'node:assert/strict'
import test from 'node:test'

import { FOLDER_SYNC_PATH_LIMITS } from '@nessie/executor-protocol'

import { heldByEditor, isIgnoredName, isIgnoredPath } from '../src/folder-sync/ignore.js'
import {
  PERSONAL_SPACE_DIR_NAME,
  idTag,
  mapTree,
  nameParts,
  renderName,
  teamFolderName,
  titleForLocalName,
  utf8Bytes,
  type MappingPage,
  type MappingSpace,
} from '../src/folder-sync/path-mapping.js'
import { conflictedCopyName, quarantineCopyName } from '../src/folder-sync/reconcile-model.js'

const SPACE: MappingSpace = { id: '10000000-0000-4000-8000-000000000001', name: 'Projects', personal: false }

let counter = 0
const page = (overrides: Partial<MappingPage> & Pick<MappingPage, 'title'>): MappingPage => {
  counter += 1
  return {
    id: `20000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    spaceId: SPACE.id,
    parentPageId: null,
    kind: 'document',
    createdAt: `2026-01-01T00:00:${String(counter % 60).padStart(2, '0')}.000Z`,
    head: { extension: 'md' },
    ...overrides,
  }
}

const pathOf = (pages: MappingPage[], target: MappingPage, spaces = [SPACE]) =>
  mapTree(spaces, pages).paths.get(target.id)

test('documents get .md, spreadsheets .xlsx, files their attachment extension once', () => {
  const doc = page({ title: 'Plan' })
  const sheet = page({ title: 'Budget', kind: 'spreadsheet', head: { extension: 'xlsx' } })
  const pdf = page({ title: 'Report', kind: 'file', head: { extension: 'pdf' } })
  const named = page({ title: 'Scan.PDF', kind: 'file', head: { extension: 'pdf' } })
  const bare = page({ title: 'LICENSE', kind: 'file', head: { extension: null } })
  const folder = page({ title: 'Archive', kind: 'folder', head: null })
  const tree = mapTree([SPACE], [doc, sheet, pdf, named, bare, folder]).paths
  assert.equal(tree.get(doc.id), 'Projects/Plan.md')
  assert.equal(tree.get(sheet.id), 'Projects/Budget.xlsx')
  assert.equal(tree.get(pdf.id), 'Projects/Report.pdf')
  assert.equal(tree.get(named.id), 'Projects/Scan.PDF')
  assert.equal(tree.get(bare.id), 'Projects/LICENSE')
  assert.equal(tree.get(folder.id), 'Projects/Archive')
})

test('names a case-insensitive file system folds together are told apart', () => {
  // NTFS and APFS compare by upper case: final and medial sigma, the long s and
  // dotless i, the micro sign and Greek mu name one file there, though their
  // plain lower cases differ. Each pair must take its own name, or two pages
  // would be written to one file.
  const pairs: Array<[string, string]> = [['Ας', 'Ασ'], ['ſtatus', 'status'], ['ıd', 'id'], ['µm', 'μm']]
  for (const [first, second] of pairs) {
    const a = page({ title: first })
    const b = page({ title: second })
    const tree = mapTree([SPACE], [a, b]).paths
    const names = [tree.get(a.id), tree.get(b.id)]
    assert.ok(names.every(Boolean), `${first} / ${second} both mapped`)
    assert.notEqual(names[0]!.toUpperCase(), names[1]!.toUpperCase(), `${first} / ${second}`)
  }
})

test('illegal characters, control characters and trailing dots and spaces are cleaned', () => {
  assert.equal(nameParts({ id: 'a', kind: 'folder', title: 'a<b>c:d"e/f\\g|h?i*j', head: null }).base, 'a_b_c_d_e_f_g_h_i_j')
  assert.equal(nameParts({ id: 'a', kind: 'folder', title: 'bell\u0007\u0000tab\u0009', head: null }).base, 'belltab')
  assert.equal(nameParts({ id: 'a', kind: 'document', title: 'Notes. . ', head: null }).base, 'Notes')
  assert.equal(nameParts({ id: 'a', kind: 'folder', title: '...', head: null }).base, '_')
})

test('Windows reserved device names are prefixed, case-insensitively and before any extension', () => {
  for (const title of ['CON', 'prn', 'Aux', 'NUL', 'com1', 'LPT9']) {
    assert.equal(nameParts({ id: 'a', kind: 'document', title, head: null }).base, `_${title}`)
  }
  assert.equal(nameParts({ id: 'a', kind: 'file', title: 'con.txt', head: { extension: 'txt' } }).base, '_con')
  assert.equal(nameParts({ id: 'a', kind: 'document', title: 'CONSOLE', head: null }).base, 'CONSOLE')
  assert.equal(nameParts({ id: 'a', kind: 'document', title: 'COM10', head: null }).base, 'COM10')
})

test('a leading dot becomes _. so the file is not hidden', () => {
  const env = page({ title: '.env', kind: 'file', head: { extension: null } })
  assert.equal(pathOf([env], env), 'Projects/_.env')
  assert.equal(isIgnoredName('_.env'), false)
})

test('a page is never mapped to a name the scanner ignores', () => {
  // A file written under an ignored name is never hashed again, so its edits
  // would never reach Nessie and its page would wait forever.
  const pages = [
    page({ title: 'Q3 numbers.tmp', kind: 'file', head: { extension: 'tmp' } }),
    page({ title: 'setup.part', kind: 'file', head: { extension: 'part' } }),
    page({ title: 'Builds.temp', kind: 'folder', head: null }),
    page({ title: '~$template', kind: 'document' }),
    page({ title: '#scratch#', kind: 'folder', head: null }),
    page({ title: 'Thumbs.db', kind: 'file', head: { extension: 'db' } }),
    page({ title: 'desktop.ini', kind: 'file', head: { extension: 'ini' } }),
    page({ title: 'Plain', kind: 'document' }),
  ]
  const spaces: MappingSpace[] = [{ id: '10000000-0000-4000-8000-0000000000aa', name: 'Logs.tmp', personal: false }]
  const tree = mapTree([SPACE, ...spaces], pages)
  for (const target of pages) {
    const path = tree.paths.get(target.id)
    assert.ok(path, target.title)
    assert.equal(isIgnoredPath(path), false, path)
  }
  assert.equal(tree.paths.get(pages.at(-1)!.id), 'Projects/Plain.md', 'ordinary names are untouched')
  assert.equal(isIgnoredName(tree.spaceDirs.get(spaces[0]!.id)!), false)
  assert.equal(isIgnoredName(teamFolderName('Drafts.part', '30000000-0000-4000-8000-000000000001', [])), false)
})

test('NFD titles map to NFC names and collide with their NFC twin', () => {
  const nfc = page({ title: 'Café' })
  const nfd = page({ title: 'Café' })
  const paths = mapTree([SPACE], [nfc, nfd]).paths
  assert.equal(paths.get(nfc.id), 'Projects/Café.md')
  assert.equal(paths.get(nfd.id), 'Projects/Café (2).md')
})

test('siblings collide case-insensitively; the oldest keeps the plain name, later ones (2), (3)', () => {
  const first = page({ title: 'Report', createdAt: '2026-01-01T00:00:00.000Z' })
  const second = page({ title: 'report', createdAt: '2026-01-02T00:00:00.000Z' })
  const third = page({ title: 'REPORT', createdAt: '2026-01-03T00:00:00.000Z' })
  const paths = mapTree([SPACE], [third, first, second]).paths
  assert.equal(paths.get(first.id), 'Projects/Report.md')
  assert.equal(paths.get(second.id), 'Projects/report (2).md')
  assert.equal(paths.get(third.id), 'Projects/REPORT (3).md')
})

test('same createdAt orders by id; a literal "(2)" title never steals a disambiguated slot twice', () => {
  const a = page({ title: 'X', createdAt: '2026-01-01T00:00:00.000Z', id: '20000000-0000-4000-8000-00000000000a' })
  const b = page({ title: 'X', createdAt: '2026-01-01T00:00:00.000Z', id: '20000000-0000-4000-8000-00000000000b' })
  const literal = page({ title: 'X (2)', createdAt: '2026-01-05T00:00:00.000Z' })
  const paths = mapTree([SPACE], [literal, b, a]).paths
  assert.equal(paths.get(a.id), 'Projects/X.md')
  assert.equal(paths.get(b.id), 'Projects/X (2).md')
  assert.equal(paths.get(literal.id), 'Projects/X (2) (2).md')
})

test('suffixes are stable: the mapping is a function of the manifest alone, in any input order', () => {
  const pages = [page({ title: 'A' }), page({ title: 'a' }), page({ title: 'B', kind: 'folder', head: null })]
  const child = page({ title: 'A', parentPageId: pages[2]!.id })
  const forward = mapTree([SPACE], [...pages, child]).paths
  const backward = mapTree([SPACE], [child, ...pages].reverse()).paths
  assert.deepEqual([...forward.entries()].sort(), [...backward.entries()].sort())
})

test('a segment over 200 bytes is truncated on a code point boundary with a ~id tag', () => {
  const long = page({ title: 'é'.repeat(150) })
  const path = pathOf([long], long)!
  const name = path.split('/')[1]!
  assert.ok(utf8Bytes(name) <= FOLDER_SYNC_PATH_LIMITS.segmentBytes)
  assert.ok(name.endsWith(`~${idTag(long.id)}.md`))
  assert.ok(!name.includes('�'))
})

test('two long titles that truncate alike still get distinct names', () => {
  const one = page({ title: `${'x'.repeat(300)}1` })
  const two = page({ title: `${'x'.repeat(300)}2` })
  const paths = mapTree([SPACE], [one, two]).paths
  assert.notEqual(paths.get(one.id), paths.get(two.id))
})

test('a deep tree keeps the path within 900 bytes by truncating the deepest segments first', () => {
  const pages: MappingPage[] = []
  let parent: string | null = null
  for (let depth = 0; depth < 6; depth += 1) {
    const folder = page({ title: `${'d'.repeat(180)}${depth}`, kind: 'folder', head: null, parentPageId: parent })
    pages.push(folder)
    parent = folder.id
  }
  const leaf = page({ title: 'leaf note', parentPageId: parent })
  pages.push(leaf)
  const mapping = mapTree([SPACE], pages)
  for (const path of mapping.paths.values()) assert.ok(utf8Bytes(path) <= FOLDER_SYNC_PATH_LIMITS.relativePathBytes)
  const shallow = mapping.paths.get(pages[0]!.id)!
  assert.equal(shallow, `Projects/${'d'.repeat(180)}0`)
  assert.ok(mapping.paths.has(leaf.id) || mapping.unmappable.get(leaf.id) === 'path_too_long')
})

test('an unmappable page never blocks its siblings (C20)', () => {
  let parent: string | null = null
  const pages: MappingPage[] = []
  for (let depth = 0; depth < 5; depth += 1) {
    const folder = page({ title: 'f'.repeat(199), kind: 'folder', head: null, parentPageId: parent })
    pages.push(folder)
    parent = folder.id
  }
  const tooDeep = page({ title: 'deep', parentPageId: parent })
  const sibling = page({ title: 'fine' })
  const mapping = mapTree([SPACE], [...pages, tooDeep, sibling])
  assert.equal(mapping.unmappable.get(tooDeep.id), 'path_too_long')
  assert.equal(mapping.paths.get(sibling.id), 'Projects/fine.md')
})

test('a page whose parent is unknown or not a folder is an orphan', () => {
  const orphan = page({ title: 'lost', parentPageId: '20000000-0000-4000-8000-ffffffffffff' })
  const doc = page({ title: 'doc' })
  const child = page({ title: 'child', parentPageId: doc.id })
  const mapping = mapTree([SPACE], [orphan, doc, child])
  assert.equal(mapping.unmappable.get(orphan.id), 'orphan')
  assert.equal(mapping.unmappable.get(child.id), 'orphan')
})

test('space directories: personal space is My Documents and sorts first; same names disambiguate', () => {
  const personal: MappingSpace = { id: '10000000-0000-4000-8000-00000000000f', name: 'Ondrej', personal: true }
  const clash: MappingSpace = { id: '10000000-0000-4000-8000-000000000002', name: 'My Documents', personal: false }
  const dirs = mapTree([clash, personal, SPACE], []).spaceDirs
  assert.equal(dirs.get(personal.id), PERSONAL_SPACE_DIR_NAME)
  assert.equal(dirs.get(clash.id), 'My Documents (2)')
  assert.equal(dirs.get(SPACE.id), 'Projects')
})

test('reverse mapping: document drops .md, files keep their name, suffixes are kept literally', () => {
  assert.equal(titleForLocalName('Report (2).md', 'document'), 'Report (2)')
  assert.equal(titleForLocalName('notes.md.md', 'document'), 'notes.md')
  assert.equal(titleForLocalName('scan.pdf', 'file'), 'scan.pdf')
  assert.equal(titleForLocalName('Café', 'folder'), 'Café')
  assert.equal(titleForLocalName('.md', 'document'), null)
})

test('renderName returns null when not even a tagged stub fits', () => {
  assert.equal(renderName({ base: 'abc', ext: '.md', id: 'abcdef12', dup: null }, 5), null)
  assert.equal(renderName({ base: 'abc', ext: '.md', id: 'abcdef12', dup: null }, 6), 'abc.md')
})

test('the team folder is the cleaned team name, with the short id when another team holds it', () => {
  assert.equal(teamFolderName('Unlike: Other AI', 't1', []), 'Unlike_ Other AI')
  assert.equal(teamFolderName('Acme', 'abcdef99-0000', ['acme']), 'Acme abcdef')
})

test('copy names keep the extension, stay within a segment and are never ignored except quarantines', () => {
  const copy = conflictedCopyName('Plan.md', 'Ondrej\'s PC: work', '2026-11-03 1405')
  assert.equal(copy, 'Plan (conflicted copy – Ondrej\'s PC_ work – 2026-11-03 1405).md')
  assert.equal(isIgnoredName(copy), false)
  const kept = quarantineCopyName('Budget.xlsx', '2026-11-03 1405')
  assert.equal(kept, 'Budget (your edit – not synced – 2026-11-03 1405).xlsx')
  assert.equal(isIgnoredName(kept), true)
  assert.equal(isIgnoredName('Budget (your edit – not synced – 2026-11-03 1405) (2).xlsx'), true)
  const long = conflictedCopyName(`${'x'.repeat(400)}.md`, 'PC', '2026-11-03 1405')
  assert.ok(utf8Bytes(long) <= FOLDER_SYNC_PATH_LIMITS.segmentBytes)
  assert.ok(long.endsWith('(conflicted copy – PC – 2026-11-03 1405).md'))
  // Nessie's labels can be long: the label gives way, never the name or the extension.
  const named = conflictedCopyName('Plan.md', `Žluťoučký ${'počítač '.repeat(40)}`, '2026-11-03 1405')
  assert.ok(utf8Bytes(named) <= FOLDER_SYNC_PATH_LIMITS.segmentBytes)
  assert.match(named, /^Plan \(conflicted copy – Žluťoučký počítač .* – 2026-11-03 1405\)\.md$/u)
})

test('ignore list (§2.3)', () => {
  for (const name of [
    '.DS_Store', 'Thumbs.db', 'desktop.ini', '~$report.docx', 'a.tmp', 'b.TEMP', '.~lock.x.odt#',
    'x.swp', '.x.swo', 'big.part', 'f.crdownload', '.nessie-sync', '.nessie-sync-move-abc', '#auto#', '.#lock', '.hidden',
  ]) assert.equal(isIgnoredName(name), true, name)
  for (const name of ['Report.md', 'thumbs.png', '_.env', 'notes~', 'a.partial']) assert.equal(isIgnoredName(name), false, name)
  assert.equal(isIgnoredPath('Space/.git/config'), true)
  assert.equal(isIgnoredPath('Space/docs/a.md'), false)
})

test('A9: a file is held while a lock or temp sibling of its name exists, and SQLite with its sidecars', () => {
  const held = (name: string, siblings: string[]) => heldByEditor(name, new Set(siblings.map((s) => s.toLowerCase())))
  assert.equal(held('Report.docx', ['~$Report.docx']), true)
  assert.equal(held('LongReport.docx', ['~$ngReport.docx']), true)
  assert.equal(held('a.odt', ['.~lock.a.odt#']), true)
  assert.equal(held('a.md', ['a.md.tmp']), true)
  assert.equal(held('a.md', ['a.tmp']), true)
  assert.equal(held('a.key', ['a.key.sb-1234-abcd']), true)
  assert.equal(held('app.sqlite', ['app.sqlite-wal']), true)
  assert.equal(held('app.db', ['app.db-journal']), true)
  assert.equal(held('a.md', ['b.md', 'b.tmp']), false)
  assert.equal(held('Design.sketch', []), false)
})
