// Headless journeys for the console's team tabs (Access, Documents, AI) against
// the shell stand-in in team-tabs-shell.mjs. Local only; never in CI.
//   node tray-windows/test/team-tabs-harness.mjs [--access-only|--documents-only|--ai-only]
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { verifyAccessTab } from './access-renderer.mjs'
import { verifyAiTab } from './ai-tab-renderer.mjs'
import { verifyDocumentsTab } from './documents-renderer.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const ui = join(root, 'packages/executor-console')
const output = join(root, '.artifacts/team-tabs/after')
await mkdir(output, { recursive: true })
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ?? (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined)
const browser = await chromium.launch({ executablePath, headless: true })
const only = (name) => process.argv.includes(`--${name}-only`)
const all = !['access', 'documents', 'ai'].some(only)
try {
  if (all || only('access')) await verifyAccessTab(browser, ui, output)
  if (all || only('documents')) await verifyDocumentsTab(browser, ui, output)
  if (all || only('ai')) await verifyAiTab(browser, ui, output)
  process.stdout.write(`Team tabs passed. Pictures: ${output}\n`)
} finally { await browser.close() }
