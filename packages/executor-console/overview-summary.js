// One-line answers the Overview shows for a team: what it may use (from
// `describe`) and who can send work to it (from `executor_audience`).
(() => {
  const nc = window.nc
  const { t } = nc
  const listFormat = new Intl.ListFormat(nc.locale, { type: 'conjunction' })
  const PROGRAM_DEFAULTS = [['unlikeotherai', 'uoaApps'], ['claudeCode', 'claudeCode'], ['codex', 'codex'], ['t3Code', 't3Code']]

  const programs = (policy) => {
    if (!policy || policy.mode === 'all') return t('overview.anyProgram')
    const parts = PROGRAM_DEFAULTS.filter(([key]) => policy.trusted?.[key]).map(([, word]) => t(`overview.${word}`))
    if (policy.allowlist?.length) parts.push(t('overview.ownPrograms', { count: policy.allowlist.length }))
    return parts.length ? parts.join(', ') : t('overview.noPrograms')
  }
  const localApps = (description) => {
    const policy = description.mcpPolicy
    if (policy?.mode === 'installed' && !policy.disabled?.length) return t('overview.allLocalApps')
    const count = Array.isArray(description.localApps)
      ? description.localApps.filter((app) => app.enabled).length
      : Object.keys(description.mcpServers ?? {}).length
    return count ? t('overview.localApps', { count }) : t('overview.noLocalApps')
  }
  const counted = (count, key, none) => (count ? t(`overview.${key}`, { count }) : t(`overview.${none}`))

  /** "2 folders · UnlikeOtherAI apps, Claude Code · all local apps · no websites" */
  const access = (description) => [
    counted(description.reach?.folders?.length ?? 0, 'folders', 'noFolders'),
    programs(description.commandPolicy),
    localApps(description),
    counted(description.reach?.allowedOrigins?.length ?? 0, 'websites', 'noWebsites'),
  ].join(' · ')

  const named = (items, total, key) => {
    const names = items.map((item) => item.name)
    const shown = names.slice(0, 3)
    const extra = Math.max(total, names.length) - shown.length
    return t(`overview.${key}`, { names: listFormat.format(extra > 0 ? [...shown, t('overview.more', { count: extra })] : shown) })
  }
  /** "Everyone in the team", or "Agents: … · People: … · Projects: …", or "Nobody yet". */
  const audience = (answer) => {
    if (answer.everyoneInTeam) return t('overview.everyone')
    const segments = [
      answer.agents?.length ? named(answer.agents, answer.agents.length, 'agents') : null,
      answer.people?.length ? named(answer.people, answer.peopleCount ?? answer.people.length, 'people') : null,
      answer.projects?.length ? named(answer.projects, answer.projects.length, 'projects') : null,
    ].filter(Boolean)
    return segments.length ? segments.join(' · ') : t('overview.nobody')
  }

  /** Documents that need the owner: the reason key, or null when nothing waits. */
  const syncAttention = (state) => {
    if (!state?.enabled) return null
    if (['root_missing', 'disk_full', 'needs_reauthorization', 'waiting_for_confirmation'].includes(state.state)) return state.state
    if (state.heldDeletes) return 'held'
    if (state.conflicts?.length || state.counts?.openConflicts > 0 || state.counts?.errors > 0 || state.state === 'needs_attention') return 'needs_attention'
    return null
  }

  nc.summary = { access, audience, syncAttention }
})()
