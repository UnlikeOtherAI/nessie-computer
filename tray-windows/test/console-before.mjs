// Captures the console as an older revision rendered it, so a change can be
// compared side by side. The old document is read with `git show`; the same
// fake host answers it (its old commands are still mocked).
import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { installRendererHost } from './renderer-host.mjs'

export const captureConsoleBefore = async (browser, root, revision, output) => {
  await mkdir(output, { recursive: true })
  const listed = execFileSync('git', ['ls-tree', '--name-only', revision, 'packages/executor-console/'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean).map((path) => path.split('/').pop())
  const resource = (file) => execFileSync('git', ['show', `${revision}:packages/executor-console/${file}`], { cwd: root, maxBuffer: 4_000_000 })
  const open = async ({ host, locale = 'en-GB', colorScheme = 'light', paired = false }) => {
    const context = await browser.newContext({ viewport: { width: 640, height: 720 }, locale, colorScheme })
    await installRendererHost(context, host, { paired })
    const page = await context.newPage()
    page.setDefaultTimeout(12000)
    await page.route('http://localhost:5875/**', async (route) => {
      const file = new URL(route.request().url()).pathname.slice(1) || 'index.html'
      const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'
      await route.fulfill({ body: listed.includes(file) ? resource(file) : '', contentType })
    })
    await page.goto('http://localhost:5875/')
    return { context, page, shot: (name) => page.screenshot({ path: join(output, `${host}-${name}.png`), fullPage: true }) }
  }
  const settle = (page) => page.waitForTimeout(600)
  for (const host of ['windows', 'macos']) {
    const { context, page, shot } = await open({ host })
    await settle(page)
    await shot('welcome')
    await page.getByRole('button', { name: /Add team|Connect a team/ }).first().click()
    await settle(page)
    await shot('connect')
    await page.keyboard.press('Escape')
    await settle(page)
    await context.close()
    const connected = await open({ host, paired: true })
    await settle(connected.page)
    await connected.shot('overview-two-teams')
    for (const [tab, name] of [[/Commands|Access/, 'access'], [/Sync|Documents/, 'documents'], [/Settings/, 'settings']]) {
      await connected.page.getByRole('tab', { name: tab }).click()
      await settle(connected.page)
      await connected.shot(name)
    }
    await connected.context.close()
  }
  for (const [name, options] of [['welcome-cs', { host: 'macos', locale: 'cs-CZ' }], ['overview-dark', { host: 'windows', colorScheme: 'dark', paired: true }]]) {
    const { context, page, shot } = await open(options)
    await settle(page)
    await shot(name)
    await context.close()
  }
  process.stdout.write(`Captured the console at ${revision} into ${output}\n`)
}
