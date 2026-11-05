import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  EXECUTOR_COMMAND_OVERHEAD_MS,
  EXECUTOR_MCP_COMMAND_TTL_MS,
  EXECUTOR_MCP_UPLOAD_BUDGET_MS,
  EXECUTOR_RESULT_IMAGE_MAXIMUM,
  EXECUTOR_RESULT_IMAGE_MAX_BYTES,
  EXECUTOR_RESULT_IMAGES_TOTAL_MAX_BYTES,
  EXECUTOR_TOOL_TIMEOUT_MARGIN_MS,
} from '@nessie/executor-protocol'

import { EXECUTOR_API_REQUEST_TIMEOUT_MS } from '../src/api-client.js'
import {
  EXECUTOR_ATTACHMENT_SERVER_ALLOWANCE_MS,
  EXECUTOR_ATTACHMENT_UPLINK_BYTES_PER_MS,
  executorAttachmentUploadTimeoutMs,
} from '../src/command-attachments.js'
import { EXECUTOR_MCP_DAEMON_COMMAND_WORST_CASE_MS } from '../src/mcp-session-manager.js'

/**
 * The worker stamps each `mcp.*` command with an expiry; the daemon spends at
 * most its composed worst case on one. When the expiry is the shorter, a call
 * still legitimately running on the machine expires into an unknown outcome
 * and aborts the run. The worst case is the session manager's own statement of
 * its sequence — a cold start, then one call deadline, the whole tools/list
 * walk included — and `mcp-session-manager.test.ts` drives a slow server
 * through both halves of that claim.
 */
test('an mcp command outlives the daemon’s worst case, its uploads and the lane’s hops', () => {
  assert.ok(
    EXECUTOR_MCP_COMMAND_TTL_MS
      >= EXECUTOR_MCP_DAEMON_COMMAND_WORST_CASE_MS + EXECUTOR_MCP_UPLOAD_BUDGET_MS + EXECUTOR_COMMAND_OVERHEAD_MS,
    `TTL ${EXECUTOR_MCP_COMMAND_TTL_MS} ms < daemon ${EXECUTOR_MCP_DAEMON_COMMAND_WORST_CASE_MS} ms + uploads + hops`,
  )
  // The worker's backstop sits past the expiry, so the expiry is what ends a
  // slow command and the backstop only one that stopped making progress.
  assert.ok(EXECUTOR_TOOL_TIMEOUT_MARGIN_MS > 0)
})

/**
 * The upload budget above is what one result's image uploads spend on a slow
 * but working uplink: at most six images and 8 MiB, each also costing Nessie
 * its own work. A single upload's deadline is a different thing — a bound on
 * one request, never shorter than any other daemon request's, because the
 * server work behind an image's answer is at least an ordinary request's. A
 * transfer-only deadline timed a busy server out on an image it went on to
 * keep, and the failed poll that followed stopped the machine's sessions.
 */
test('one result’s image uploads fit the upload budget, and no upload is timed shorter than a request', () => {
  const transfer = Math.ceil(EXECUTOR_RESULT_IMAGES_TOTAL_MAX_BYTES / EXECUTOR_ATTACHMENT_UPLINK_BYTES_PER_MS)
  const serverWork = EXECUTOR_RESULT_IMAGE_MAXIMUM * EXECUTOR_ATTACHMENT_SERVER_ALLOWANCE_MS
  assert.ok(
    transfer + serverWork <= EXECUTOR_MCP_UPLOAD_BUDGET_MS,
    `8 MiB at ${EXECUTOR_ATTACHMENT_UPLINK_BYTES_PER_MS} B/ms (${transfer} ms) + ${serverWork} ms of server work > ${EXECUTOR_MCP_UPLOAD_BUDGET_MS} ms`,
  )
  for (const bytes of [1, 13_715, 900_000, EXECUTOR_RESULT_IMAGE_MAX_BYTES]) {
    assert.ok(executorAttachmentUploadTimeoutMs(bytes) >= EXECUTOR_API_REQUEST_TIMEOUT_MS, `${bytes} bytes`)
  }
  // The transfer on top grows with the bytes: a 4 MiB image on a 2 Mbit/s uplink.
  const largest = executorAttachmentUploadTimeoutMs(EXECUTOR_RESULT_IMAGE_MAX_BYTES)
  assert.ok(largest > executorAttachmentUploadTimeoutMs(13_715))
  assert.equal(
    largest,
    EXECUTOR_API_REQUEST_TIMEOUT_MS
      + Math.ceil(EXECUTOR_RESULT_IMAGE_MAX_BYTES / EXECUTOR_ATTACHMENT_UPLINK_BYTES_PER_MS),
  )
})
