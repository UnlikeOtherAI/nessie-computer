// The one failure translator. A failure arrives as `{ code?, message }`; the
// code decides, and when the CLI gave only its message (it prints
// `error.message` and nothing else), the fixed literals beside each code in
// `executor-manage` identify it. Anything else is quoted honestly under
// Details rather than mislabelled. Remedies name what `executor_apply_remedy`
// should do (contract §5.1: `reProposePolicy`, `restartExecutor`, `openNessie`);
// this window handles `openNessie` itself through `executor_open_nessie`.
(() => {
  const nc = window.nc
  const { t } = nc
  const KNOWN = [
    { code: 'EXECUTOR_DESCRIPTOR_ROLLBACK', messages: ['Executor descriptor revisions cannot move backwards.'], remedy: 'reProposePolicy', label: 'sendAgain' },
    { code: 'EXECUTOR_DESCRIPTOR_REVISION_CONFLICT', messages: ['A descriptor revision cannot describe two different policies.'], remedy: 'reProposePolicy', label: 'sendAgain' },
    { code: 'EXECUTOR_CONNECTION_FENCED', messages: ['Executor connection is fenced.'], remedy: 'restartExecutor', label: 'reconnect' },
    { code: 'EXECUTOR_DAEMON_PROOF_INVALID', messages: ['Executor proof is invalid.', 'Executor descriptor proof is invalid.'], remedy: null },
    { code: 'EXECUTOR_HEARTBEAT_STALE', messages: ['Executor heartbeat is stale.', 'Executor control call is stale.'], remedy: 'restartExecutor', label: 'reconnect' },
    { code: 'FINGERPRINT_NOT_CONFIRMED', messages: ['No active executor enrollment is ready to confirm.', 'The confirmation fingerprint does not match the pending executor.'], remedy: 'openNessie', label: 'openNessie' },
    { code: 'ENROLLMENT_EXPIRED', messages: ['No active executor enrollment is ready'], remedy: 'openNessie', label: 'openNessie' },
    { code: 'EXECUTOR_API_TIMEOUT', messages: ['Executor API request timed out.'], remedy: 'restartExecutor', label: 'tryAgain' },
  ]

  /**
   * `{ code, explanation, remedy: { id, label } | null, detail }` for one
   * failure. `detail` is what the CLI or Nessie actually said, for Details.
   */
  const translate = (failure) => {
    const message = typeof failure === 'string' ? failure : String(failure?.message ?? '')
    const detail = message.trim()
    const code = typeof failure === 'object' && failure?.code ? String(failure.code) : null
    const known = KNOWN.find((entry) => entry.code === code)
      ?? KNOWN.find((entry) => entry.messages.some((literal) => detail.includes(literal)))
    if (!known) {
      return { code, explanation: t(detail ? 'errors.unknown' : 'errors.empty'), remedy: null, detail }
    }
    return {
      code: known.code,
      explanation: t(`errors.${known.code}`),
      remedy: known.remedy ? { id: known.remedy, label: t(`errors.${known.label}`) } : null,
      detail,
    }
  }

  /**
   * Fills a failure block: the explanation, the one remedy button and the
   * Details disclosure holding the code and the raw sentence. `onRemedy(id)`
   * runs the button; `openNessie` opens the team's Nessie from this window.
   */
  const render = (container, failure, { executorId, onRemedy }) => {
    const translated = translate(failure)
    container.replaceChildren()
    const explanation = document.createElement('p')
    explanation.className = 'failure-explanation'
    explanation.textContent = translated.explanation
    container.append(explanation)
    if (translated.remedy) {
      const button = document.createElement('button')
      button.textContent = translated.remedy.label
      button.dataset.remedy = translated.remedy.id
      button.onclick = () => nc.attempt(async () => {
        if (translated.remedy.id === 'openNessie') {
          await nc.invoke('executor_open_nessie', { executorId })
          return
        }
        button.disabled = true
        try { await onRemedy(translated.remedy.id) } finally { button.disabled = false }
      }, { target: button })
      container.append(button)
    }
    if (translated.detail || translated.code) {
      const details = document.createElement('details')
      details.className = 'failure-details'
      const summary = document.createElement('summary')
      summary.textContent = t('shell.details')
      const text = document.createElement('p')
      text.textContent = [translated.code, translated.detail].filter(Boolean).join(' · ')
      details.append(summary, text)
      container.append(details)
    }
    return translated
  }

  nc.failure = { translate, render }
})()
