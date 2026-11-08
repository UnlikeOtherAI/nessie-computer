import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPatchAuthor, selectedImports } from '../extraction/author.mjs'
import { readSessionEngineSnapshot } from '../../../packaging/session-engine/snapshot.mjs'
import { prepareSessionEngineSnapshot } from '../../../packaging/session-engine/engine-snapshot.mjs'

const ws = 'apps/server/src/ws.ts'
const target = 'apps/server/src/orchestration-v2/SessionControl.ts'

/** Original intake, retry and wire projection, without product startup or analytics.
 * The runtime owner must admit delivery before evaluating these effects.
 */
export const generateSessionControlManifest = snapshot => {
  const author = createPatchAuthor(snapshot)
  const dispatch = author.between(ws, '                  (command.type === "prepared-run.retry"',
    '                  ).pipe(Effect.provide(intakeContext)),')
  const dispatchHandler = author.between(ws, '        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]:',
    '        [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]:')
  const dispatchError = dispatchHandler.slice(dispatchHandler.indexOf('                  Effect.mapError((cause) => {'),
    dispatchHandler.lastIndexOf('                ),'))
  const launch = author.between(ws, '                  ThreadMessageIntake.launchThread({',
    '                  }).pipe(Effect.provide(intakeContext)),')
  const launchResult = author.between(ws, '                  Effect.map((result) => ({\n                    ...result,',
    '                ),\n            ),\n          ),\n        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]')
  const body = dispatch + dispatchError + launch + launchResult
  const redirects = new Map([
    ['apps/server/src/orchestration-v2/ThreadManagementService.ts',
      'apps/server/src/orchestration-v2/ThreadManagementService.session-api.ts'],
  ])
  const imports = selectedImports(author.read(ws), body, ws, target, redirects)
    + 'import type { OrchestrationV2Command, OrchestrationV2ThreadLaunchInput, OrchestrationV2ThreadLaunchResult, OrchestrationV2DispatchCommandResult } from "@t3tools/contracts";\n'
    + 'import type { ThreadManagementProvenance } from "./ThreadManagementService.session-api.ts";\n'
    + 'import * as ThreadLaunch from "./ThreadLaunchService.ts";\n'
  author.derive(target, [imports,
    'type Services<T> = T extends Effect.Effect<infer _A, infer _E, infer R> ? R : never;\n',
    'export const dispatchCommand = (command: OrchestrationV2Command, provenance: ThreadManagementProvenance): Effect.Effect<OrchestrationV2DispatchCommandResult, OrchestrationV2DispatchCommandError, Services<ReturnType<typeof ThreadMessageIntake.dispatchCommand>> | ThreadLaunch.ThreadLaunchService> => Effect.gen(function* () {\n'
      + '  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;\n  return yield* ',
    author.sourcePart(ws, dispatch, { current: true }),
    ').pipe(Effect.map((result) => ({ sequence: result.sequence })),\n',
    author.sourcePart(ws, dispatchError, { current: true }), ');\n});\n\n',
    'export const launchThread = (input: OrchestrationV2ThreadLaunchInput, provenance: ThreadManagementProvenance): Effect.Effect<OrchestrationV2ThreadLaunchResult, OrchestrationV2ThreadLaunchError, Services<ReturnType<typeof ThreadMessageIntake.launchThread>>> =>\n',
    author.sourcePart(ws, launch, { current: true }), '}).pipe(\n', author.sourcePart(ws, launchResult, { current: true }), ');\n',
  ], 'extract-session-control')
  // Provenance comes from the admitted caller, not a client-controlled payload.
  author.replace(target, 'createdBy: "user",\n                          creationSource:\n                            "creationSource" in command ? command.creationSource : "web",',
    '...provenance,', 'control-dispatch-provenance')
  author.replace(target, 'createdBy: "user",\n                    creationSource: input.creationSource ?? "web",',
    '...provenance,', 'control-launch-provenance')
  // Startup admission belongs to the executor. No source server startup is composed here.
  const startup = author.between(target, '                    ServerRuntimeStartupError: (cause) =>',
    '                    ThreadManagementProviderInstanceDisabledError: (cause) =>')
  author.replace(target, startup, '', 'control-executor-startup-boundary')

  const schedules = 'apps/server/src/scheduledTasks/ScheduledTaskService.ts'
  const port = schedules.replace('.ts', '.session-port.ts')
  const webhook = author.between(schedules, 'export interface WebhookTriggerRequest extends', 'const webhookFilters =')
  const service = author.between(schedules, 'export class ScheduledTaskService extends', 'function taskError(')
  author.derive(port, [selectedImports(author.read(schedules), webhook + service, schedules, port),
    author.sourcePart(schedules, webhook), author.sourcePart(schedules, service)], 'extract-schedule-control-port')
  author.replace(schedules, webhook,
    'import type { WebhookTriggerRequest, WebhookTriggerResult, WebhookDeliveryOutcome } from "./ScheduledTaskService.session-port.ts";\n'
      + 'export type { WebhookTriggerRequest, WebhookTriggerResult, WebhookDeliveryOutcome } from "./ScheduledTaskService.session-port.ts";\n\n',
    'share-schedule-control-types')
  author.replace(schedules, service,
    'import { ScheduledTaskService } from "./ScheduledTaskService.session-port.ts";\n'
      + 'export { ScheduledTaskService };\n\n', 'share-schedule-control-tag')
  return { format: 1, sourceCommit: snapshot.identity.commit, patches: author.patches }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const original = await readSessionEngineSnapshot(process.argv[2])
  const { snapshot } = prepareSessionEngineSnapshot(original, { includeSessionControl: false })
  const manifest = generateSessionControlManifest(snapshot)
  await writeFile(new URL('./boundary-patches.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`${manifest.patches.length} source-bound control operations\n`)
}
