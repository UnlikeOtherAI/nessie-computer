// One-line answers the Overview shows for a team: what it may use (from
// `describe`) and whether its documents need the owner.
(() => {
  const nc = window.nc
  const { t } = nc
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

  /** Documents that need the owner: the reason key, or null when nothing waits. */
  const syncAttention = (state) => {
    if (!state?.enabled) return null
    if (['root_missing', 'disk_full', 'needs_reauthorization', 'waiting_for_confirmation'].includes(state.state)) return state.state
    if (state.heldDeletes) return 'held'
    if (state.conflicts?.length || state.counts?.openConflicts > 0 || state.counts?.errors > 0 || state.state === 'needs_attention') return 'needs_attention'
    return null
  }

  nc.summary = { access, syncAttention }
})()
