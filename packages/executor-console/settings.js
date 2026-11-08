// Settings: switches that save when pressed, each failure beside its switch.
(() => {
  const nc = window.nc
  const { byId, invoke, t } = nc

  /** A switch reads its value once, saves when pressed and goes back if the save fails. */
  const wire = (id, read, write) => {
    const input = byId(id)
    const load = async () => { input.checked = (await invoke(read))?.enabled === true }
    input.onchange = () => {
      const wanted = input.checked
      input.disabled = true
      nc.attempt(async () => {
        try { await invoke(write, { enabled: wanted }) } catch (error) {
          input.checked = !wanted
          throw new Error(t('settings.saveFailed', { reason: error?.message ?? error }))
        }
      }, { target: input }).finally(() => { input.disabled = false })
    }
    return load
  }
  const loadAutostart = wire('autostart', 'executor_autostart', 'executor_set_autostart')
  const loadAutoRestart = wire('auto-restart', 'executor_auto_restart', 'executor_set_auto_restart')

  byId('autostart-label').textContent = t('settings.autostart')
  byId('auto-restart-label').textContent = t('settings.autoRestart')
  byId('auto-restart-hint').textContent = t('settings.autoRestartHint')
  byId('notifications-title').textContent = t('settings.notifications')
  byId('notifications-body').textContent = t('settings.notificationsBody')
  byId('help-title').textContent = t('settings.help')
  byId('open-logs').textContent = t('settings.openLogs')
  byId('help-cli').textContent = t('settings.cli')
  byId('help-version').textContent = t('settings.version', { version: t('updates.unknown') })
  byId('open-logs').onclick = () => nc.attempt(() => invoke('executor_open_logs'), { target: byId('open-logs') })
  nc.updates.onStatus((status) => {
    byId('help-version').textContent = t('settings.version', { version: status?.installedVersion || t('updates.unknown') })
  })

  window.addEventListener('DOMContentLoaded', () => {
    for (const load of [loadAutostart, loadAutoRestart]) load().catch((error) => nc.reportError(error, byId('tab-settings').querySelector('.tab-error')))
  })
})()
