import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { linuxSoftwarePage } from './page.mjs'

export const stageLinuxConsole = async (root, resources) => {
  const destination = join(resources, 'console')
  await mkdir(destination, { recursive: true })
  for (const file of ['style.css', 'i18n.js', 'help.js', 'update-notes.js', 'updates.js', 'updates-words.js']) {
    await copyFile(join(root, 'packages/executor-console', file), join(destination, file))
  }
  for (const file of ['app.py', 'native.js']) {
    await copyFile(join(root, 'packaging/linux/console', file), join(destination, file))
  }
  await writeFile(join(destination, 'index.html'), linuxSoftwarePage(
    await readFile(join(root, 'packages/executor-console/index.html'), 'utf8')))
}

export const linuxConsoleLauncher = (release) => [
  '#!/bin/sh', 'set -eu',
  'unset PYTHONPATH PYTHONHOME LD_PRELOAD LD_LIBRARY_PATH NODE_OPTIONS NODE_PATH',
  `exec /usr/bin/python3 -I ${release}/resources/console/app.py "$@"`, '',
].join('\n')

export const linuxConsoleDesktop = (background = false) => [
  '[Desktop Entry]', 'Type=Application', 'Name=Nessie Computer',
  `Exec=/usr/bin/nessie-executor-app${background ? ' --background' : ''}`,
  'Icon=computer-symbolic', 'Terminal=false', 'Categories=Utility;',
  'StartupNotify=true', ...(background ? ['X-GNOME-Autostart-enabled=true'] : []), '',
].join('\n')
