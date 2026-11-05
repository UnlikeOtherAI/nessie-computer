import { execFile, spawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { CHATGPT_ISSUER, ChatgptAuthError } from './chatgpt-oauth-provider.js'
import { packagedNativeHelperPath } from './state-security.js'

const refuse = (): never => { throw new ChatgptAuthError('oauth_browser_unavailable') }

const openNativeBrowser = async (url: string): Promise<void> => {
  if (process.env.NESSIE_EXECUTOR_PACKAGED_CLI !== '1') return refuse()
  await new Promise<void>((resolve, reject) => {
    const child = spawn(packagedNativeHelperPath(), ['personal-chatgpt-browser'], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }
        : { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    })
    let output = '', settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (ok) resolve()
      else { child.kill(); reject(new ChatgptAuthError('oauth_browser_unavailable')) }
    }
    const timer = setTimeout(() => finish(false), 5000)
    child.once('error', () => finish(false)); child.stdin.once('error', () => finish(false))
    child.stdout.on('data', (bytes: Buffer) => { output += bytes.toString('utf8'); if (output.length > 4096) finish(false) })
    child.once('close', code => {
      try {
        const value: unknown = JSON.parse(output)
        finish(code === 0 && !!value && typeof value === 'object' && !Array.isArray(value)
          && Object.keys(value).sort().join(',') === 'status,version'
          && 'status' in value && value.status === 'verified' && 'version' in value && value.version === 1)
      } catch { finish(false) }
    })
    child.stdin.end(JSON.stringify({ url }))
  })
}

export const chatgptBrowserAuthorizationUrl = (value: string): string => {
  if (value.length > 128 * 1024) return refuse()
  const url = new URL(value)
  if (url.origin !== CHATGPT_ISSUER || url.pathname !== '/api/accounts/authorize'
    || url.username || url.password || url.hash || url.searchParams.get('response_type') !== 'code') refuse()
  return url.toString()
}

/** Uses the user's actual desktop portal; no browser is adopted by the credential supervisor. */
export const openChatgptBrowser = async (authorizationUrl: string): Promise<void> => {
  const url = chatgptBrowserAuthorizationUrl(authorizationUrl)
  if (process.platform === 'darwin' || process.platform === 'win32') return openNativeBrowser(url)
  const uid = process.getuid?.()
  if (process.platform !== 'linux' || uid === undefined || uid === 0) return refuse()
  const directory = `/run/user/${uid}`
  const folder = await lstat(directory).catch(() => null)
  const socket = await lstat(join(directory, 'bus')).catch(() => null)
  const binary = await lstat('/usr/bin/gdbus').catch(() => null)
  if (!folder?.isDirectory() || folder.isSymbolicLink() || folder.uid !== uid || (folder.mode & 0o077) !== 0
    || await realpath(directory) !== directory || !socket?.isSocket() || socket.isSymbolicLink() || socket.uid !== uid
    || !binary?.isFile() || binary.isSymbolicLink() || binary.uid !== 0 || (binary.mode & 0o022) !== 0) return refuse()
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('LD_') && !key.startsWith('GIO_') && !key.startsWith('GTK_')
    && !['GCONV_PATH', 'LOCPATH', 'GLIBC_TUNABLES', 'DBUS_SESSION_BUS_ADDRESS',
      'GSETTINGS_SCHEMA_DIR', 'OPENSSL_CONF', 'OPENSSL_MODULES'].includes(key)))
  await new Promise<void>((resolve, reject) => {
    execFile('/usr/bin/gdbus', ['call', '--session', '--dest', 'org.freedesktop.portal.Desktop',
      '--object-path', '/org/freedesktop/portal/desktop', '--method', 'org.freedesktop.portal.OpenURI.OpenURI',
      '', url, '{}'], { timeout: 5_000, maxBuffer: 32 * 1024, windowsHide: true,
      env: { ...environment, DBUS_SESSION_BUS_ADDRESS: `unix:path=${directory}/bus`, GIO_USE_VFS: 'local' } },
    (error) => {
      // execFile errors include argv. They may contain an ID-token hint/state,
      // so neither that error nor broker output may cross the local boundary.
      if (error) reject(new ChatgptAuthError('oauth_browser_unavailable'))
      else resolve()
    })
  })
}
