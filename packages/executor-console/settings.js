// Settings: the selected team first — Pause/Resume and Disconnect… — then
// the computer: switches that save when pressed, Software updates, logs.
(() => {
  const nc = window.nc
  const { byId, invoke, t } = nc

  // ---- the selected team
  const renderTeam = () => {
    const executorId = nc.team.current()
    const team = executorId ? nc.team.get(executorId) : null
    byId('settings-team').hidden = !team
    if (!team) return
    const status = byId('settings-team-title')
    status.dataset.tone = nc.team.status(team)
    status.textContent = nc.team.statusWord(team)
    const pause = byId('settings-pause')
    pause.textContent = t(team.paused ? 'teams.resume' : 'teams.pause')
    pause.disabled = false
    byId('settings-disconnect').textContent = t('teams.disconnect')
    byId('settings-disconnect').setAttribute('aria-label', `${t('teams.disconnect')} ${nc.team.label(executorId)}`)
  }
  byId('settings-pause').onclick = () => {
    const team = nc.team.get(nc.team.current())
    if (!team) return
    const pause = byId('settings-pause')
    nc.attempt(async () => {
      pause.disabled = true
      pause.textContent = t(team.paused ? 'teams.resuming' : 'teams.pausing')
      try { await nc.team.setPaused(team.executorId, !team.paused) } finally { renderTeam() }
    }, { target: pause })
  }
  byId('settings-disconnect').onclick = () => { if (nc.team.current()) nc.team.disconnect(nc.team.current()) }

  // ---- the computer
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
          throw new Error(t('settings.saveFailed', { reason: nc.failure.sentence(error).text }))
        }
      }, { target: input }).finally(() => { input.disabled = false })
    }
    return load
  }
  const loadAutostart = wire('autostart', 'executor_autostart', 'executor_set_autostart')
  const loadAutoRestart = wire('auto-restart', 'executor_auto_restart', 'executor_set_auto_restart')

  byId('autostart-label').textContent = t('settings.autostart')
  byId('auto-restart-label').textContent = t('settings.autoRestart')
  const restartHelp = nc.help(t('settings.autoRestartHint'), { describes: byId('auto-restart') })
  restartHelp.id = 'auto-restart-help'
  byId('auto-restart-label').after(restartHelp)
  byId('open-logs').textContent = t('settings.openLogs')
  const logsHelp = nc.help(t('settings.cli'), { describes: byId('open-logs') })
  logsHelp.id = 'open-logs-help'
  byId('open-logs').after(logsHelp)
  byId('open-logs').onclick = () => nc.attempt(() => invoke('executor_open_logs'), { target: byId('open-logs') })

  nc.team.onChange(renderTeam)
  nc.team.onListChange(renderTeam)
  nc.view.onChange((tab) => { if (tab === 'settings') renderTeam() })
  window.addEventListener('DOMContentLoaded', () => {
    renderTeam()
    for (const load of [loadAutostart, loadAutoRestart]) load().catch((error) => nc.reportError(error, byId('tab-settings').querySelector('.tab-error')))
  })
})()
