// Both native hosts render this exact document. One entry runs every console
// journey: the shell, the Access, Documents and AI tabs, and Software updates.
// Local only, never CI. Flags:
//   (none)                 every journey, both hosts, seven locales, light and dark, 640×680 and 440×500
//   --only=<a,b>           some of shell, access, documents, documents-teams, ai, updates — for iterating on one tab
//   --output=<dir>         where pictures go (default .artifacts/executor-console)
//   --before=<rev>         captures of the console as it was at <rev>, into <output>/before, for comparison
//   --updates-only …       Software updates journeys alone (see docs/automatic-updates.md)
//   --updates-stuck-only   the Mac helper-stuck state in Needs you and Settings, seven locales, no pictures
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { consoleFiles } from './renderer-host.mjs'
import { verifyConsoleShell } from './console-renderer.mjs'
import { captureConsoleBefore } from './console-before.mjs'
import { verifySoftwareUpdates } from './updates-renderer.mjs'
import { verifyUpdatesStuck } from './updates-stuck-renderer.mjs'
import { verifyAccessTab } from './access-renderer.mjs'
import { verifyDocumentsTab } from './documents-renderer.mjs'
import { captureDocumentsTeamsBefore, verifyDocumentsTeams } from './documents-teams-renderer.mjs'
import { verifyAiTab } from './ai-tab-renderer.mjs'
import { verifyAiLocal } from './ai-local-renderer.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const ui = join(root, 'packages/executor-console')
const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1]
const output = resolve(root, flag('output') ?? '.artifacts/executor-console')
const only = flag('only')?.split(',') ?? ['shell', 'access', 'documents', 'documents-teams', 'ai', 'updates']
const before = flag('before')
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ?? (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined)
const browser = await chromium.launch({ executablePath, headless: true })
const files = [...consoleFiles.shell, ...consoleFiles.teamTabs]
try {
  if (before) {
    await captureConsoleBefore(browser, root, before, join(output, 'before'))
    await captureDocumentsTeamsBefore(browser, root, before, join(output, 'before'))
    process.exit(0)
  }
  if (process.argv.includes('--updates-stuck-only')) {
    await verifyUpdatesStuck(browser, ui, files)
    process.exit(0)
  }
  if (process.argv.some((arg) => arg.startsWith('--updates'))) {
    await verifySoftwareUpdates(browser, ui, files, root)
    process.exit(0)
  }
  const after = join(output, 'after')
  await mkdir(after, { recursive: true })
  if (only.includes('shell')) await verifyConsoleShell(browser, ui, after)
  if (only.includes('access')) await verifyAccessTab(browser, ui, after)
  if (only.includes('documents')) await verifyDocumentsTab(browser, ui, after)
  if (only.includes('documents-teams')) await verifyDocumentsTeams(browser, ui, after)
  if (only.includes('ai')) await verifyAiTab(browser, ui, after)
  if (only.includes('ai')) await verifyAiLocal(browser, ui)
  if (only.includes('updates')) {
    await verifySoftwareUpdates(browser, ui, files, root)
    await verifyUpdatesStuck(browser, ui, files)
  }
  process.stdout.write(`Shared Windows/macOS console passed. Pictures: ${after}\n`)
} finally { await browser.close() }
