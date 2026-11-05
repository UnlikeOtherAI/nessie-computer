import { verifyInferenceTestState } from './local-inference-security.ts'
import { LocalInferenceCoordinator } from '../../src/local-inference-coordinator.ts'

const hold = async () => {
  process.stdout.write('crash-boundary\n')
  await new Promise(() => { setInterval(() => undefined, 1_000) })
}
await LocalInferenceCoordinator.open({
  directory: process.argv[2],
  security: process.platform === 'win32' ? { helper: verifyInferenceTestState } : {},
  lock: process.argv[3] === 'before' ? { beforePublish: hold } : { afterRecoveryPublish: hold },
})
