import { selectedImports } from './author.mjs'

/** Extract the original clone map so inspection and authorized clone operations
 * share one owner. The read interfaces expose no fake mutators or lifecycle. */
export function extractInspectionHosts(author, redirects) {
  const settings = redirects.get('apps/server/src/serverSettings.ts')
  const settingsEnd = author.read(settings).slice(-100)
  author.replace(settings, settingsEnd, settingsEnd + `
export class ServerSettingsReadService extends Context.Service<ServerSettingsReadService,
  Pick<ServerSettingsService["Service"], "getSettings">>()("nessie/session-engine/ServerSettingsRead") {}
`, 'inspection-settings-read-contract')

  const file = 'apps/server/src/project/ProjectCloneTracker.ts'
  const port = redirects.get(file)
  const state = 'apps/server/src/project/ProjectCloneState.ts'
  const original = author.read(file)
  const tracked = author.between(file, 'interface TrackedClone {', '/** @public */')
  const get = author.between(file, '  const get: ProjectCloneTracker["Service"]["get"] =',
    '  const cancel: ProjectCloneTracker["Service"]["cancel"] =')
  const imports = selectedImports(original, tracked + get, file, state, redirects)
  author.derive(state, [imports,
    'import * as Context from "effect/Context";\nimport * as Layer from "effect/Layer";\n'
      + 'import type { ProjectId } from "@t3tools/contracts";\n',
    author.sourcePart(file, tracked),
    `export class ProjectCloneState extends Context.Service<ProjectCloneState, {
  readonly clones: Ref.Ref<Map<ProjectId, TrackedClone>>;
}>()("t3/project/ProjectCloneState") {}
export const stateLayer = Layer.effect(ProjectCloneState, Effect.gen(function* () {
  const clones = yield* Ref.make(new Map<ProjectId, TrackedClone>());
  return { clones };
}));
export const readLayer = Layer.effect(ProjectCloneReadService, Effect.gen(function* () {
  const { clones } = yield* ProjectCloneState;
`, author.sourcePart(file, get),
    `  return { get };
})).pipe(Layer.provideMerge(stateLayer));
`], 'inspection-original-clone-map')
  // These tag imports are additional to the original selected type imports.
  const first = author.read(state).match(/^import[\s\S]*?;/u)[0]
  author.replace(state, first,
    `import { ProjectCloneReadService } from "./ProjectCloneTracker.session-port.ts";\n${first}`,
    'inspection-clone-read-tag-import')
  author.replace(file, tracked, '', 'share-original-clone-state-type')
  author.replace(file, '  const clones = yield* Ref.make(new Map<ProjectId, TrackedClone>());',
    '  const { clones } = yield* ProjectCloneState;', 'share-original-clone-state-instance')
  author.replace(file, 'export const layer = Layer.effect(ProjectCloneTracker, make);',
    'export const layer = Layer.effect(ProjectCloneTracker, make).pipe(Layer.provide(stateLayer));',
    'share-original-clone-state-layer')
  const firstLive = author.read(file).match(/^import[\s\S]*?;/u)[0]
  author.replace(file, firstLive,
    `import { ProjectCloneState, stateLayer, type TrackedClone } from "./ProjectCloneState.ts";\n${firstLive}`,
    'share-original-clone-state-import')
  author.replace(state, 'interface TrackedClone {', 'export interface TrackedClone {', 'share-clone-record-type')
  const suffix = author.read(port).slice(-100)
  author.replace(port, suffix, suffix + `
export class ProjectCloneReadService extends Context.Service<ProjectCloneReadService,
  Pick<ProjectCloneTracker["Service"], "get">>()("nessie/session-engine/ProjectCloneRead") {}
`, 'inspection-clone-read-contract')
  author.replace(port, 'tracker: ProjectCloneTracker["Service"],',
    'tracker: Pick<ProjectCloneTracker["Service"], "get">,', 'inspection-clone-guard-read-contract')
}
