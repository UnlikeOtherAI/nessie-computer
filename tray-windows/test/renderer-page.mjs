// Opens the real console document (`index.html` and every script it loads)
// against the fake host, for one host flavour, locale, window size and colour
// scheme; and the checks every journey shares.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { consoleFiles, installRendererHost } from './renderer-host.mjs'
import { installSyncHost, syncState, syncTrash } from './sync-fixtures.mjs'

export const LOCALES = ['en-GB', 'en-US', 'cs', 'de', 'es', 'fr', 'it']
/** The desktop window and the smallest window the apps allow. */
export const SIZES = { desktop: { width: 640, height: 680 }, minimum: { width: 440, height: 500 } }
const files = [...consoleFiles.shell, ...consoleFiles.teamTabs]

/** Serves the console from disk; any other path is a defect. */
export const serveConsole = (ui) => async (page) => {
  await page.route('http://localhost:5875/**', async (route) => {
    const file = new URL(route.request().url()).pathname.slice(1) || 'index.html'
    assert.ok(files.includes(file), `index.html asked for ${file}, which the console does not list`)
    const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'
    await route.fulfill({ body: await readFile(join(ui, file)), contentType })
  })
}

/**
 * One console window. `paired` teams start connected (the first a new
 * pairing, the second an older team with its own rules); `sync` is the
 * Documents fixture; `legacy` describes teams as an older runtime would.
 * Page errors and missing translations are collected, never swallowed.
 */
export const openConsole = async (browser, ui, { host, locale = 'en-GB', dark = false, size = 'desktop', paired = 0, legacy = false,
  sync = undefined, ownerConfirmationRequired = false, context: given = null } = {}) => {
  const context = given ?? await browser.newContext({ viewport: SIZES[size], locale, colorScheme: dark ? 'dark' : 'light' })
  await installRendererHost(context, host, { paired, legacy, ownerConfirmationRequired })
  if (sync !== null) await installSyncHost(context, sync ?? syncState(host), syncTrash)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'warning' && /Missing translation/.test(message.text())) errors.push(message.text()) })
  page.setDefaultTimeout(12000)
  await serveConsole(ui)(page)
  await page.goto('http://localhost:5875/')
  return { context, page, errors }
}

/** Opens a tab by its position, so the journey reads in any language. */
export const showTab = (page, name) => page.getByRole('tab').nth(['overview', 'access', 'documents', 'ai', 'settings'].indexOf(name)).click()
export const selectTeam = (page, executorId) => page.locator('#team-select').selectOption(executorId)

export const lastCall = (page, command) => page.evaluate((name) => window.calls.filter((call) => call.command === name).at(-1), command)
export const callArgs = (page, command) => page.evaluate((name) => window.calls.filter((call) => call.command === name).map((call) => call.args), command)
export const callCount = (page, command) => page.evaluate((name) => window.calls.filter((call) => call.command === name).length, command)

/**
 * Pictures of what the window shows: the viewport, and when the page scrolls,
 * a second picture scrolled to the end, so a reviewer sees the whole tab as a
 * person would by scrolling. The scroll position is put back.
 */
export const screenshot = async (page, output, name) => {
  await page.screenshot({ path: join(output, `${name}.png`), animations: 'disabled' })
  const scrolled = await page.evaluate(() => {
    const main = document.querySelector('dialog[open]') ?? document.querySelector('main')
    if (main.scrollHeight <= main.clientHeight + 8) return false
    main.scrollTop = main.scrollHeight
    return true
  })
  if (!scrolled) return
  await page.screenshot({ path: join(output, `${name}-scrolled.png`), animations: 'disabled' })
  await page.evaluate(() => { (document.querySelector('dialog[open]') ?? document.querySelector('main')).scrollTop = 0 })
}

/** Nothing in the window, the open tab or the open dialog runs past its box, nothing is clipped, and no word key leaked onto the page. */
export const assertFits = async (page, label) => {
  const problems = await page.evaluate(() => {
    const found = []
    const root = document.documentElement
    if (root.scrollWidth > root.clientWidth) found.push(`page scrolls sideways (${root.scrollWidth} > ${root.clientWidth})`)
    const scopes = [document.querySelector('header'), document.querySelector('footer'), document.querySelector('.team-row:not([hidden])'),
      ...document.querySelectorAll('[role=tabpanel]:not([hidden])'), ...document.querySelectorAll('dialog[open]')].filter(Boolean)
    for (const scope of scopes) {
      const edge = scope.getBoundingClientRect().right + 0.5
      for (const node of [scope, ...scope.querySelectorAll('*')]) {
        if (node.closest('[hidden]') || !node.getClientRects().length || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT'
          || node.classList.contains('visually-hidden') || node.getAttribute('aria-hidden') === 'true') continue
        const box = node.getBoundingClientRect()
        const name = node.id || node.className || node.tagName
        if (box.right > edge) found.push(`${name} runs past its container by ${Math.round(box.right - edge)}px`)
        if (['BUTTON', 'P', 'H1', 'H2', 'H3', 'LI', 'SPAN', 'SMALL', 'LABEL', 'OUTPUT'].includes(node.tagName)
          && node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0) found.push(`${name} clips its text`)
      }
    }
    if (/\b(shell|access|documents|ai|chatgpt|overview|teams|pairing|settings|updates|errors)\.[a-zA-Z]+\.[a-zA-Z.]+/.test(document.body.innerText)) {
      found.push('a word key leaked onto the page')
    }
    return found
  })
  assert.deepEqual(problems, [], label)
}
