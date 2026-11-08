import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } from '@nessie/t3-session-source/contracts'
import { InteractiveVoiceProtocol } from '../../dist/t3-session/interactive/voice.js'
import { scope } from './fixture.mjs'

const destination = { executorId: 'transcription:another-computer', environmentId: 'voice:雪' }
const voice = () => new InteractiveVoiceProtocol(scope, destination, destination)
const start = JSON.stringify({ type: 'start', options: DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS })
const pcm = () => new Uint8Array(new Float32Array([0, 0.5, -0.5]).buffer)

test('explicit transcription destination stays separate from the coding source; no fallback', () => {
  const protocol = voice()
  assert.equal(protocol.source.executorId, scope.executorId)
  assert.equal(protocol.destination.executorId, destination.executorId)
  assert.throws(() => new InteractiveVoiceProtocol(scope, destination, scope), /resource_mismatch/u)
})

test('original PCM/start/ready/update/finish protocol retains equal revision ACKs', () => {
  const protocol = voice()
  assert.throws(() => protocol.pcm(pcm()), /invalid_voice_state/u)
  protocol.command(start)
  assert.throws(() => protocol.pcm(pcm()), /invalid_voice_state/u)
  protocol.event('{"type":"ready"}')
  protocol.pcm(pcm())
  protocol.event('{"type":"update","revision":0,"text":null}')
  protocol.pcm(pcm())
  protocol.event('{"type":"update","revision":0,"text":null}')
  protocol.command('{"type":"finish"}')
  assert.deepEqual(protocol.event('{"type":"finished","text":"synthetic dictation"}'),
    { type: 'finished', text: 'synthetic dictation' })
  assert.throws(() => protocol.command(start), /invalid_voice_state/u)
})

test('malformed PCM, queued demand, unearned ACK and premature finish are rejected', () => {
  const protocol = voice()
  protocol.command(start)
  protocol.event('{"type":"ready"}')
  assert.throws(() => protocol.pcm(new Uint8Array(3)), /invalid_pcm/u)
  assert.throws(() => protocol.pcm(new Uint8Array(new Float32Array([NaN]).buffer)), /invalid_pcm/u)
  assert.throws(() => protocol.event('{"type":"update","revision":0,"text":null}'), /invalid_voice_state/u)
  protocol.pcm(pcm())
  protocol.pcm(pcm())
  assert.throws(() => protocol.pcm(pcm()), /stream_capacity/u)
  protocol.command('{"type":"finish"}')
  assert.throws(() => protocol.event('{"type":"finished","text":"lost audio"}'), /invalid_voice_state/u)
  protocol.cancel()
  assert.throws(() => protocol.pcm(pcm()), /invalid_voice_state/u)
})

test('regressed source revisions fail; acknowledgement never means transcription completed', () => {
  const protocol = voice()
  protocol.command(start)
  protocol.event('{"type":"ready"}')
  protocol.pcm(pcm())
  protocol.event('{"type":"update","revision":5,"text":{"committed":"a","tentative":"b"}}')
  protocol.pcm(pcm())
  assert.throws(() => protocol.event('{"type":"update","revision":4,"text":null}'), /source_sequence_regressed/u)
  protocol.event('{"type":"error","message":"fixture hardware lost"}')
  assert.throws(() => protocol.command('{"type":"finish"}'), /invalid_voice_state/u)
})
