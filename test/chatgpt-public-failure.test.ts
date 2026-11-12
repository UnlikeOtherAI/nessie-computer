import assert from 'node:assert/strict'
import test from 'node:test'
import { ExecutorApiError } from '../src/api-client.js'
import { ChatgptAuthError } from '../src/chatgpt-oauth-provider.js'
import { publicChatgptFailure } from '../src/chatgpt-public-failure.js'
import { PersonalInferenceProtectionError } from '../src/personal-inference-paths.js'

test('a deployment refusal and a revoked owner keep their distinct recovery reasons', () => {
  assert.equal(publicChatgptFailure(new ExecutorApiError('private diagnostic', {
    status: 403, code: 'CHATGPT_DEPLOYMENT_UNAVAILABLE',
  })), 'deployment_ineligible')
  for (const code of ['CHATGPT_AUTHORITY_UNAVAILABLE', 'CHATGPT_OWNER_UNAVAILABLE', 'EXECUTOR_CONNECTION_FENCED']) {
    assert.equal(publicChatgptFailure(new ExecutorApiError('private diagnostic', { code })), 'owner_authority_unavailable')
  }
  assert.equal(publicChatgptFailure(new ExecutorApiError('private diagnostic', {
    code: 'PERSONAL_INFERENCE_AUTHORITY_UNAVAILABLE', status: 503,
  })), 'connection_unavailable')
})

test('native custody, active sessions and provider sign-in failures do not become network errors', () => {
  assert.equal(publicChatgptFailure(new PersonalInferenceProtectionError(
    'personal_inference_managed_inventory_unverified')), 'runtime_inventory_unknown')
  assert.equal(publicChatgptFailure(new PersonalInferenceProtectionError(
    'personal_inference_incompatible_sessions')), 'host_sessions_active')
  assert.equal(publicChatgptFailure(new ChatgptAuthError('oauth_discovery_invalid')), 'registration_unavailable')
})

test('unknown diagnostics and token-shaped messages never cross the public status boundary', () => {
  for (const error of [new Error('access_token=private'), { code: 'CHATGPT_DEPLOYMENT_UNAVAILABLE' }, null]) {
    assert.equal(publicChatgptFailure(error), 'connection_unavailable')
  }
})
