import { runLocalOpenAiCli } from './openai-local-cli.js'
import { LocalInferenceCoordinator } from './local-inference-coordinator.js'

/** Host-local controls; they contain neither pairing credentials nor model data. */
export const runLocalInferenceCli = async (args: string[]): Promise<boolean> => {
  if (await runLocalOpenAiCli(args)) return true
  if (args[0] !== 'local-inference') return false
  const action = args[1]
  if (!['status', 'pause', 'resume', 'confirm-stopped'].includes(action ?? '')
    || action === 'confirm-stopped' && (args.length !== 3 || args[2] !== '--confirm-ollama-stopped')
    || action !== 'confirm-stopped' && args.length !== 2) {
    throw new Error('Usage: nessie-executor local-inference status|pause|resume|confirm-stopped --confirm-ollama-stopped')
  }
  const coordinator = await LocalInferenceCoordinator.open()
  if (action === 'pause') await coordinator.pause()
  if (action === 'resume') await coordinator.resume()
  if (action === 'confirm-stopped') await coordinator.confirmStopped()
  const control = await coordinator.control()
  process.stdout.write(`${JSON.stringify({ ...control, healthReason: await coordinator.healthReason() })}\n`)
  return true
}
