// Real subprocess fixture for the SDK transport, never a Claude/native creator.
import { createInterface } from 'node:readline'

const input = createInterface({ input: process.stdin })
// A transport regression must fail this bounded fixture, never strand a child.
const lifetime = setTimeout(() => process.exit(124), 10_000)
process.stderr.write(Buffer.alloc(Number(process.env.T3_SDK_FIXTURE_STDERR_BYTES ?? 0), 120))
const notice = Buffer.from('Příliš 🦊\n')
process.stderr.write(notice.subarray(0, 2))
process.stderr.write(notice.subarray(2))
for await (const line of input) {
  const frame = JSON.parse(line)
  if (frame.type === 'control_request') {
    process.stdout.write(JSON.stringify({ type: 'control_response', response: {
      subtype: 'success', request_id: frame.request_id, response: frame.request.subtype === 'mcp_set_servers'
        ? { added: Object.keys(frame.request.servers ?? {}), removed: [], errors: {} } : {
        commands: [], models: [], agents: [], account: {},
      },
    } }) + '\n')
  } else if (frame.type === 'user') {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init',
      session_id: 'fixture-session', uuid: '00000000-0000-4000-8000-000000000001', echo: frame }) + '\n')
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success',
      is_error: false, result: 'fixture', num_turns: 1, session_id: 'fixture-session' }) + '\n')
  }
}
clearTimeout(lifetime)
