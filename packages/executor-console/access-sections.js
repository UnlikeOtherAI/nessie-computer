// Access sections that save when pressed: Folders, Websites, Local apps and
// Coding assistants. Programs, which applies explicitly, is access-programs.js.
(() => {
  const nc = window.nc
  const access = window.accessTab
  const t = access.t
  // Where the runtime found a local app (`LOCAL_APP_SOURCES` in src/mcp-servers.ts);
  // `configured` means the owner named it.
  const LOCAL_APP_SOURCES = { unlikeotherai: 'unlikeotherai', 'claude-code': 'claudeCode', codex: 'codex' }
  const setText = (id, text) => { nc.byId(id).textContent = text }
  // A folder is shown by its own name, as the person's file manager shows it.
  const folderLabel = (path) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
  // A new folder is named after its directory, the way the runtime names one.
  const folderName = (path, folders) => {
    const stem = folderLabel(path).toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'folder'
    const taken = new Set(folders.map((folder) => folder.name))
    let name = stem
    for (let index = 2; taken.has(name); index += 1) name = `${stem.slice(0, 36)}-${index}`
    return name
  }
  const button = (text, onclick, attributes = {}) => {
    const node = document.createElement('button')
    node.type = 'button'
    node.textContent = text
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value)
    node.onclick = onclick
    return node
  }
  /** A section's heading row: its title, a "?" holding what the section is for, and its one action. */
  const heading = (node, name, action) => {
    const row = document.createElement('div')
    row.className = 'section-heading'
    const titleRow = document.createElement('div')
    titleRow.className = 'label-row'
    const title = document.createElement('h3')
    title.id = `access-${name}-title`
    const help = nc.help('')
    help.id = `access-${name}-help`
    titleRow.append(title, help)
    row.append(titleRow)
    if (action) row.append(action)
    node.append(row)
    return { title, help }
  }
  /** A small dialog with one text field; `check(value)` answers the saved value or an error key. */
  const inputDialog = (id, { title, label, hint, confirm, cancel, placeholder }, check, accept) => {
    const dialog = document.createElement('dialog')
    dialog.id = id
    dialog.setAttribute('aria-labelledby', `${id}-title`)
    dialog.innerHTML = `<h2 id="${id}-title" tabindex="-1"></h2><form><div class="label-row"><label for="${id}-input" id="${id}-label"></label></div>`
      + `<input id="${id}-input" maxlength="512" autocomplete="off" aria-errormessage="${id}-error">`
      + `<p id="${id}-error" class="field-error" role="alert" hidden></p>`
      + `<div class="actions"><button type="button" id="${id}-cancel"></button><button type="submit" id="${id}-confirm" class="primary"></button></div></form>`
    document.body.append(dialog)
    const input = dialog.querySelector('input')
    const help = nc.help('', { describes: input })
    help.id = `${id}-help`
    dialog.querySelector('.label-row').append(help)
    if (placeholder) input.placeholder = placeholder
    dialog.querySelector(`#${id}-cancel`).onclick = () => dialog.close()
    dialog.querySelector('form').onsubmit = (event) => {
      event.preventDefault()
      const outcome = check(input.value.trim())
      const error = dialog.querySelector(`#${id}-error`)
      if (outcome.error) {
        error.textContent = t(outcome.error)
        error.hidden = false
        input.setAttribute('aria-invalid', 'true')
        return
      }
      dialog.close()
      accept(outcome.value)
    }
    return {
      open: () => {
        for (const [selector, key] of [['h2', title], ['label', label], [`#${id}-confirm`, confirm], [`#${id}-cancel`, cancel]]) {
          dialog.querySelector(selector).textContent = t(key)
        }
        help.set(t(hint))
        input.value = ''
        input.removeAttribute('aria-invalid')
        dialog.querySelector(`#${id}-error`).hidden = true
        dialog.showModal()
        input.focus()
      },
    }
  }

  // Folders: rows with the name agents use, Remove, Add folder… The runtime
  // keeps at least one folder (workspace-folders.ts), so the last Remove waits.
  access.register('folders', (() => {
    let list; let add; let help
    const inForce = (input) => t('save.inForce.folders', { list: access.list(input.workspaceFolders.map((folder) => folderLabel(folder.path))) })
    return {
      build: (node) => {
        add = button('', () => nc.attempt(async () => {
          const path = await nc.invoke('executor_choose_folder')
          if (!path) return
          // Native and runtime validation own path, overlap and name rules.
          access.edit({ section: 'folders', target: add, inForce, mutate: (input) => {
            if (input.workspaceFolders.some((folder) => folder.path === path)) return false
            const name = folderName(path, input.workspaceFolders)
            input.workspaceFolders = [...input.workspaceFolders, { name, path }]
          } })
        }), { id: 'access-add-folder' })
        ;({ help } = heading(node, 'folders', add))
        list = document.createElement('div')
        list.id = 'access-folder-list'
        node.append(list)
      },
      render: ({ input, label }) => {
        setText(`access-folders-title`, t('sections.folders'))
        // What the folders are for, why the last Remove is off, and why several folders stop some work — one "?".
        // (The runtime keeps at least one folder; the browser, sandboxed commands and coding sessions need exactly one.)
        help.set([t('folders.intro', { team: label }), input.workspaceFolders.length === 1 ? t('folders.last') : null,
          input.workspaceFolders.length >= 2 ? t('folders.multiple') : null].filter(Boolean).join(' '))
        add.textContent = t('folders.add')
        access.keepFocus(list, () => {
          list.replaceChildren()
          for (const folder of input.workspaceFolders) {
            const remove = button(t('folders.remove'), () => access.edit({ section: 'folders', target: list, inForce, mutate: (draft) => {
              if (!draft.workspaceFolders.some((entry) => entry.name === folder.name)) return false
              draft.workspaceFolders = draft.workspaceFolders.filter((entry) => entry.name !== folder.name)
            } }), { 'aria-label': t('folders.removeLabel', { folder: folderLabel(folder.path), team: label }) })
            remove.disabled = input.workspaceFolders.length === 1
            list.append(access.row({ name: folderLabel(folder.path), detail: `${folder.path} · ${t('folders.agentsUse', { name: folder.name })}`, control: remove, key: folder.name }))
          }
        }, () => add)
      },
    }
  })())

  // Websites: HTTPS origins the agent browser may open, kept whether or not the browser is set up yet.
  const origin = (value) => {
    try {
      const url = new URL(value.includes('://') ? value : `https://${value}`)
      if (url.protocol !== 'https:' || url.username || url.password || (url.pathname !== '/' && url.pathname) || url.search || url.hash) return null
      return url.origin
    } catch { return null }
  }
  access.register('websites', (() => {
    let list; let add; let note; let help; let empty
    const inForce = (input) => t('save.inForce.websites', { list: access.list(input.allowedOrigins) })
    const dialog = inputDialog('access-website-dialog', { title: 'websites.addTitle', label: 'websites.addLabel', hint: 'websites.addHint',
      confirm: 'websites.addConfirm', cancel: 'websites.cancel', placeholder: 'https://docs.example.com' }, (value) => {
      const site = origin(value)
      if (!site) return { error: 'websites.invalid' }
      if (access.view()?.input.allowedOrigins.includes(site)) return { error: 'websites.duplicate' }
      return { value: site }
    }, (site) => access.edit({ section: 'websites', target: add, inForce, mutate: (input) => {
      if (input.allowedOrigins.includes(site)) return false
      input.allowedOrigins = [...input.allowedOrigins, site]
    } }))
    return {
      build: (node) => {
        add = button('', () => dialog.open(), { id: 'access-add-website' })
        ;({ help } = heading(node, 'websites', add))
        note = document.createElement('p')
        note.id = 'access-browser-note'
        note.className = 'access-note'
        list = document.createElement('div')
        list.id = 'access-website-list'
        empty = document.createElement('p')
        empty.id = 'access-websites-empty'
        empty.className = 'hint'
        node.append(note, list, empty)
      },
      render: ({ input, saved, label }) => {
        setText('access-websites-title', t('sections.websites'))
        help.set(t('websites.intro', { team: label }))
        add.textContent = t('websites.add')
        note.hidden = saved.sandbox?.browserConfigured !== false
        note.textContent = t('websites.notSetUp')
        access.keepFocus(list, () => {
          list.replaceChildren()
          for (const site of input.allowedOrigins) {
            const remove = button(t('folders.remove'), () => access.edit({ section: 'websites', target: list, inForce, mutate: (draft) => {
              if (!draft.allowedOrigins.includes(site)) return false
              draft.allowedOrigins = draft.allowedOrigins.filter((entry) => entry !== site)
            } }), { 'aria-label': t('websites.removeLabel', { site }) })
            list.append(access.row({ name: site, control: remove, key: site }))
          }
        }, () => add)
        empty.hidden = input.allowedOrigins.length > 0
        empty.textContent = t('websites.empty')
      },
    }
  })())

  // Local apps: every installed local MCP server, on unless the owner switched
  // it off; an app the owner named (`configured`) is removed rather than switched.
  access.register('localApps', (() => {
    let list; let help; let empty
    const inForce = (input, saved) => t('save.inForce.localApps', { list: access.list((saved?.localApps ?? [])
      .filter((app) => !input.mcpPolicy?.disabled.includes(app.name) && !input.mcpServerRemovals?.includes(app.name))
      .map((app) => app.name)) })
    /**
     * Removing an owner-named app sends only its name. The page never sees a
     * server's environment, so it never sends the list back: the runtime keeps
     * every other server exactly as stored.
     */
    const removeConfigured = (app, saved) => access.edit({ section: 'localApps', target: list, inForce: (draft) => inForce(draft, saved),
      mutate: (draft) => {
        if (draft.mcpServerRemovals?.includes(app.name)) return false
        draft.mcpServerRemovals = [...(draft.mcpServerRemovals ?? []), app.name]
      } })
    return {
      build: (node) => {
        ;({ help } = heading(node, 'localApps'))
        list = document.createElement('div')
        list.id = 'access-local-app-list'
        empty = document.createElement('p')
        empty.id = 'access-local-apps-empty'
        empty.className = 'hint'
        node.append(list, empty)
      },
      render: ({ input, saved, label }) => {
        setText('access-localApps-title', t('sections.localApps'))
        help.set(t('localApps.intro', { team: label }))
        const apps = saved.localApps
        access.keepFocus(list, () => {
          list.replaceChildren()
          for (const app of apps ?? []) {
            if (app.source === 'configured' && input.mcpServerRemovals?.includes(app.name)) continue
            if (app.source === 'configured') {
              const remove = button(t('folders.remove'), () => removeConfigured(app, saved), { 'aria-label': t('localApps.removeLabel', { app: app.name, team: label }) })
              list.append(access.row({ name: app.name, detail: t('programs.ownerAdded'), control: remove, key: app.name }))
              continue
            }
            const enabled = !input.mcpPolicy?.disabled.includes(app.name)
            const toggle = access.toggle({ label: t('localApps.switchLabel', { team: label, app: app.name }), checked: enabled,
              disabled: !input.mcpPolicy, onchange: (on) => access.edit({ section: 'localApps', target: list,
                inForce: (draft) => inForce(draft, saved), mutate: (draft) => {
                  const disabled = new Set(draft.mcpPolicy.disabled)
                  if (on === !disabled.has(app.name)) return false
                  if (on) disabled.delete(app.name)
                  else disabled.add(app.name)
                  draft.mcpPolicy = { ...draft.mcpPolicy, disabled: [...disabled].sort() }
                } }) })
            const source = t(`localApps.source.${LOCAL_APP_SOURCES[app.source] ?? 'other'}`)
            list.append(access.row({ name: app.name, detail: app.installed === false ? `${source} · ${t('localApps.notInstalled')}` : source,
              control: toggle, key: app.name, disabled: app.installed === false }))
          }
        }, () => list)
        empty.hidden = Boolean(apps?.length)
        empty.textContent = apps ? t('localApps.empty') : t('localApps.unavailable')
      },
    }
  })())

  // Coding assistants, collapsed under "For developers": conversation access and the Claude Code channel recipe.
  access.register('coding', (() => {
    let details; let summary; let sessions; let sessionsText; let help; let setup; let dialog; let config
    const inForce = (input) => t(input.existingCodingSessionsEnabled ? 'save.inForce.codingOn' : 'save.inForce.codingOff')
    const copy = async (block, trigger) => {
      try {
        await navigator.clipboard.writeText(block.textContent)
        trigger.textContent = t('coding.copied')
        setTimeout(() => { trigger.textContent = t('coding.copy') }, 2000)
      } catch {
        // The page may not be allowed to write to the clipboard; the text is selected instead.
        window.getSelection().selectAllChildren(block)
        throw new Error(t('coding.copyFailed'))
      }
    }
    return {
      build: (node) => {
        node.innerHTML = `<h3 id="access-coding-title" class="visually-hidden"></h3><details class="access-developers" id="access-developers"><summary id="access-developers-summary"></summary>`
          + `<label class="toggle"><input id="access-existing-sessions" type="checkbox"><span id="access-existing-sessions-text"></span></label>`
          + `<p><button type="button" id="access-claude-setup" class="link"></button></p></details>`
        details = node.querySelector('details')
        summary = node.querySelector('summary')
        sessions = node.querySelector('#access-existing-sessions')
        sessionsText = node.querySelector('#access-existing-sessions-text')
        help = nc.help('', { describes: sessions })
        help.id = 'access-existing-sessions-help'
        sessionsText.after(help)
        setup = node.querySelector('#access-claude-setup')
        sessions.onchange = () => {
          const enabled = sessions.checked
          access.edit({ section: 'coding', target: details, inForce, mutate: (input) => {
            if (input.existingCodingSessionsEnabled === enabled) return false
            input.existingCodingSessionsEnabled = enabled
          } })
        }
        dialog = document.createElement('dialog')
        dialog.id = 'access-claude-dialog'
        dialog.setAttribute('aria-labelledby', 'access-claude-title')
        dialog.innerHTML = '<h2 id="access-claude-title" tabindex="-1"></h2><div id="access-claude-steps"><p id="access-claude-step1"></p>'
          + '<pre id="access-claude-config" class="code"></pre><button type="button" id="access-claude-copy-config"></button>'
          + '<p id="access-claude-step2"></p><pre id="access-claude-command" class="code">claude --mcp-config nessie-channel.json --dangerously-load-development-channels server:nessie</pre>'
          + '<button type="button" id="access-claude-copy-command"></button></div><p id="access-claude-unavailable" hidden></p>'
          + '<p class="dialog-error" role="alert" hidden></p><div class="actions"><button type="button" id="access-claude-close"></button></div>'
        document.body.append(dialog)
        config = dialog.querySelector('#access-claude-config')
        dialog.querySelector('#access-claude-close').onclick = () => dialog.close()
        for (const [id, block] of [['access-claude-copy-config', config], ['access-claude-copy-command', dialog.querySelector('#access-claude-command')]]) {
          const trigger = dialog.querySelector(`#${id}`)
          trigger.onclick = () => nc.attempt(() => copy(block, trigger), { target: trigger })
        }
        setup.onclick = () => {
          const view = access.view()
          const configuration = view?.saved.existingClaudeChannelConfiguration
          dialog.querySelector('#access-claude-steps').hidden = !configuration
          dialog.querySelector('#access-claude-unavailable').hidden = Boolean(configuration)
          config.textContent = configuration ? JSON.stringify(configuration, null, 2) : ''
          dialog.showModal()
          dialog.querySelector('h2').focus()
        }
      },
      render: ({ input }) => {
        setText('access-coding-title', t('sections.coding'))
        summary.textContent = t('coding.developers')
        sessionsText.textContent = t('coding.sessions')
        help.set(t('coding.sessionsHint'))
        setup.textContent = t('coding.claudeSetup')
        if (document.activeElement !== sessions) sessions.checked = input.existingCodingSessionsEnabled
        for (const [id, key] of [['access-claude-title', 'coding.claudeTitle'], ['access-claude-step1', 'coding.step1'], ['access-claude-step2', 'coding.step2'],
          ['access-claude-copy-config', 'coding.copy'], ['access-claude-copy-command', 'coding.copy'], ['access-claude-unavailable', 'coding.claudeUnavailable'],
          ['access-claude-close', 'coding.close']]) nc.byId(id).textContent = t(key)
        for (const node of [dialog, details]) node.lang = document.documentElement.lang
      },
    }
  })())

})()
