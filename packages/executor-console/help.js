// The one "?" control. An explanation that would otherwise be a paragraph
// sits behind a small button beside the control it explains: shown on hover
// and on keyboard focus, pinned by a click, closed by Escape, and read by
// screen readers through aria-describedby on the button and on the control.
(() => {
  const nc = window.nc
  let counter = 0
  let pinned = null

  const describe = (element, id) => {
    if (!(element instanceof Element)) return
    const existing = element.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ?? []
    if (!existing.includes(id)) element.setAttribute('aria-describedby', [...existing, id].join(' '))
  }

  /** Keeps the tip inside the window and inside the dialog or page it belongs to. */
  const place = (wrap, tip) => {
    tip.style.left = '0px'
    const bound = (wrap.closest('dialog, [role=tabpanel], .team-row, .needs') ?? document.body).getBoundingClientRect()
    const right = Math.min(bound.right, window.innerWidth) - 8
    const box = tip.getBoundingClientRect()
    if (box.right > right) tip.style.left = `${Math.round(right - box.right)}px`
    const after = tip.getBoundingClientRect()
    if (after.left < bound.left + 8) tip.style.left = `${Math.round(parseFloat(tip.style.left) + bound.left + 8 - after.left)}px`
  }

  /**
   * `nc.help(text, { describes })` answers a `<span class="help">` holding the
   * button and its tip. `describes` names the control(s) the text explains;
   * each gets `aria-describedby` pointing at the tip. `set(text)` rewrites the
   * words at a later render; `hidden` follows `show(false)`.
   */
  const help = (text, { describes = [] } = {}) => {
    const id = `help-${++counter}`
    const wrap = document.createElement('span')
    wrap.className = 'help'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'help-button'
    button.textContent = '?'
    button.setAttribute('aria-label', nc.t('shell.help'))
    button.setAttribute('aria-describedby', id)
    button.setAttribute('aria-expanded', 'false')
    const tip = document.createElement('span')
    tip.id = id
    tip.className = 'help-tip'
    tip.setAttribute('role', 'tooltip')
    tip.hidden = true
    tip.textContent = text
    wrap.append(button, tip)
    for (const element of [describes].flat()) describe(element, id)

    const show = (on) => {
      if (on && pinned && pinned !== wrap) pinned.show(false)
      tip.hidden = !on
      // A tip that opened under a resting pointer never takes a click meant for the button beneath it.
      tip.classList.toggle('pinned', on && pinned === wrap)
      button.setAttribute('aria-expanded', String(on))
      if (on) place(wrap, tip)
      else if (pinned === wrap) pinned = null
    }
    wrap.show = show
    button.onmouseenter = () => show(true)
    button.onmouseleave = () => { if (pinned !== wrap) show(false) }
    button.onfocus = () => show(true)
    button.onblur = () => { if (pinned !== wrap) show(false) }
    button.onclick = (event) => {
      event.preventDefault()
      if (pinned === wrap) { show(false); return }
      pinned = wrap
      show(true)
    }
    return Object.assign(wrap, { set: (next) => { tip.textContent = next; if (!tip.hidden) place(wrap, tip) } })
  }

  // Escape closes whatever tip is showing, before a dialog reads the same key as Cancel.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    const open = document.querySelector('.help-tip:not([hidden])')?.parentElement
    if (!open) return
    event.preventDefault()
    event.stopPropagation()
    open.show(false)
    open.querySelector('button').focus()
  }, true)
  // A click anywhere else unpins.
  document.addEventListener('pointerdown', (event) => {
    if (pinned && !pinned.contains(event.target)) pinned.show(false)
  }, true)

  window.nc.help = help
})()
