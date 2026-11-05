import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { CodingAgentConfig } from '../src/coding-session/config.js'
import { claudeMergeCommands, claudeUnaskedCommands } from '../src/coding-session/merge-commands.js'

/**
 * The signed `mergeCommands` fact: which of git push, gh pr create, gh pr
 * checks and gh pr merge Claude Code may run unasked, read from the reviewed
 * configuration as Claude Code reads a Bash rule, and never more generously.
 */

const claude = (over: Partial<CodingAgentConfig> = {}): CodingAgentConfig => ({
  allowedTools: [], args: [], command: ['claude'], disallowedTools: [], ...over,
})

const ALL = ['git push', 'gh pr create', 'gh pr checks', 'gh pr merge']

test('bypassPermissions runs every merge command unasked, whatever the lists say', () => {
  assert.deepEqual(claudeMergeCommands(claude({ permissionMode: 'bypassPermissions' })), ALL)
})

test('no Claude Code, or no allowed tools, allows none', () => {
  assert.deepEqual(claudeMergeCommands(undefined), [])
  assert.deepEqual(claudeMergeCommands(claude({ permissionMode: 'acceptEdits' })), [])
})

test('the four rule spellings each cover what they cover and nothing more', () => {
  assert.deepEqual(claudeMergeCommands(claude({ allowedTools: ['Bash'] })), ALL)
  assert.deepEqual(claudeMergeCommands(claude({ allowedTools: ['Bash(*)'] })), ALL)
  assert.deepEqual(claudeMergeCommands(claude({ allowedTools: ['Bash(git *)', 'Bash(gh *)'] })), ALL)
  assert.deepEqual(
    claudeMergeCommands(claude({ allowedTools: ['Bash(git push:*)', 'Bash(gh pr create:*)', 'Bash(gh pr checks:*)'] })),
    ['git push', 'gh pr create', 'gh pr checks'],
  )
  assert.deepEqual(claudeMergeCommands(claude({ allowedTools: ['Bash(gh pr:*)'] })), ['gh pr create', 'gh pr checks', 'gh pr merge'])
  assert.deepEqual(claudeMergeCommands(claude({ allowedTools: ['Bash(gi*)'] })), ['git push'])
})

test('a rule that only looks close covers nothing', () => {
  for (const entry of ['Bash(git push)', 'Bash(git)', 'Bash(gith *)', 'Bash(g*t push)', 'Read(*)', 'Bash(pnpm *)', 'bash']) {
    assert.deepEqual(claudeMergeCommands(claude({ allowedTools: [entry] })), [], entry)
  }
})

test('a disallowed rule takes a command back', () => {
  assert.deepEqual(
    claudeMergeCommands(claude({ allowedTools: ['Bash(git *)', 'Bash(gh *)'], disallowedTools: ['Bash(gh pr merge:*)'] })),
    ['git push', 'gh pr create', 'gh pr checks'],
  )
})

/*
 * The signed `unaskedCommands` fact: whether Claude Code may run any command
 * at all without asking, which standing machine access needs its author's own
 * "run any command" tick for.
 */

test('bypassPermissions, or a rule for every command, runs any command unasked', () => {
  assert.equal(claudeUnaskedCommands(claude({ permissionMode: 'bypassPermissions' })), 'any')
  assert.equal(claudeUnaskedCommands(claude({ permissionMode: 'bypassPermissions', disallowedTools: ['Bash'] })), 'any')
  for (const entry of ['Bash', 'Bash(*)', 'Bash(:*)', ' Bash ']) {
    assert.equal(claudeUnaskedCommands(claude({ allowedTools: ['Read', entry] })), 'any', entry)
  }
})

test('rules that name commands, or no Claude Code at all, run only what is listed', () => {
  assert.equal(claudeUnaskedCommands(undefined), 'listed')
  assert.equal(claudeUnaskedCommands(claude()), 'listed')
  assert.equal(claudeUnaskedCommands(claude({ permissionMode: 'acceptEdits' })), 'listed')
  for (const entry of ['Bash(git *)', 'Bash(gh pr:*)', 'Bash(g*)', 'Bash()', 'Read(*)', 'bash']) {
    assert.equal(claudeUnaskedCommands(claude({ allowedTools: [entry] })), 'listed', entry)
  }
})

test('only a disallowed rule for every command takes "any" back', () => {
  assert.equal(claudeUnaskedCommands(claude({ allowedTools: ['Bash'], disallowedTools: ['Bash'] })), 'listed')
  assert.equal(claudeUnaskedCommands(claude({ allowedTools: ['Bash(*)'], disallowedTools: ['Bash(:*)'] })), 'listed')
  // Everything but rm still runs unasked.
  assert.equal(claudeUnaskedCommands(claude({ allowedTools: ['Bash'], disallowedTools: ['Bash(rm:*)'] })), 'any')
})
