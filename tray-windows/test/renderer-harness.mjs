// Both native hosts render this exact document. Only native IPC is replaced.
// Local only, never CI. Flags:
//   (none)             shell journeys for both hosts, then Software updates
//   --shell-only       the same, serving the team-tab scripts (tranche E2) empty
//   --before=<rev>     captures of the console as it was at <rev>, for comparison
//   --updates-only …   Software updates journeys (see docs/automatic-updates.md)
import assert from 'node:assert/strict'
import { access, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { consoleFiles } from './renderer-host.mjs'
import { verifyConsoleShell } from './console-renderer.mjs'
import { captureConsoleBefore } from './console-before.mjs'
import { verifySoftwareUpdates } from './updates-renderer.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const ui = join(root, 'packages/executor-console')
const output = join(root, '.artifacts/executor-console')
const files = [...consoleFiles.shell, ...consoleFiles.teamTabs]
const shellOnly = process.argv.includes('--shell-only')
const before = process.argv.find((arg) => arg.startsWith('--before='))?.split('=')[1]
await mkdir(join(output, 'after'), { recursive: true })
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ?? (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined)
const browser = await chromium.launch({ executablePath, headless: true })
const exists = (file) => access(join(ui, file)).then(() => true, () => false)
const served = new Set()
/** Serves the console from disk; a team-tab script that is not there yet is served empty, once noted. */
const serve = async (page) => {
  await page.route('http://localhost:5875/**', async (route) => {
    const file = new URL(route.request().url()).pathname.slice(1) || 'index.html'
    assert.ok(files.includes(file), file)
    const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'
    if (consoleFiles.teamTabs.includes(file) && (shellOnly || !(await exists(file)))) {
      if (!served.has(file)) { served.add(file); process.stdout.write(`serving ${file} empty\n`) }
      await route.fulfill({ body: '', contentType })
      return
    }
    await route.fulfill({ body: await readFile(join(ui, file)), contentType })
  })
}
try {
  if (before) {
    await captureConsoleBefore(browser, root, before, join(output, 'before'))
    process.exit(0)
  }
  if (process.argv.some((arg) => arg.startsWith('--updates'))) {
    await verifySoftwareUpdates(browser, ui, consoleFiles.shell, root)
    process.exit(0)
  }
  await verifyConsoleShell(browser, serve, join(output, 'after'))
  await verifySoftwareUpdates(browser, ui, consoleFiles.shell, root)
  process.stdout.write(`Shared Windows/macOS console passed. Screenshots: ${output}\n`)
} finally { await browser.close() }
