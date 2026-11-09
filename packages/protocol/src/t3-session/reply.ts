// Generated result/error/stream relations; do not edit.
import * as Schema from 'effect/Schema'
import { ExecutorT3Routing } from './routing.js'
import { ExecutorT3Descriptors as D, type ExecutorT3Method } from './methods.js'
// Resolve stream relations at generation time instead of structurally inferring
// both Schema parameters through every original RPC in each downstream compiler.
type Replies = {
  "server.probe": { value: typeof D["server.probe"]['successSchema']; error: typeof D["server.probe"]['errorSchema']; kind: 'result' }
  "server.getConfig": { value: typeof D["server.getConfig"]['successSchema']; error: typeof D["server.getConfig"]['errorSchema']; kind: 'result' }
  "server.refreshProviders": { value: typeof D["server.refreshProviders"]['successSchema']; error: typeof D["server.refreshProviders"]['errorSchema']; kind: 'result' }
  "server.updateSettings": { value: typeof D["server.updateSettings"]['successSchema']; error: typeof D["server.updateSettings"]['errorSchema']; kind: 'result' }
  "peerLinks.list": { value: typeof D["peerLinks.list"]['successSchema']; error: typeof D["peerLinks.list"]['errorSchema']; kind: 'result' }
  "scheduledTasks.subscribe": { value: typeof D["scheduledTasks.subscribe"]['successSchema']['success']; error: typeof D["scheduledTasks.subscribe"]['errorSchema'] | typeof D["scheduledTasks.subscribe"]['successSchema']['error']; kind: 'stream' }
  "scheduledTasks.upsert": { value: typeof D["scheduledTasks.upsert"]['successSchema']; error: typeof D["scheduledTasks.upsert"]['errorSchema']; kind: 'result' }
  "scheduledTasks.setEnabled": { value: typeof D["scheduledTasks.setEnabled"]['successSchema']; error: typeof D["scheduledTasks.setEnabled"]['errorSchema']; kind: 'result' }
  "scheduledTasks.delete": { value: typeof D["scheduledTasks.delete"]['successSchema']; error: typeof D["scheduledTasks.delete"]['errorSchema']; kind: 'result' }
  "scheduledTasks.runNow": { value: typeof D["scheduledTasks.runNow"]['successSchema']; error: typeof D["scheduledTasks.runNow"]['errorSchema']; kind: 'result' }
  "projects.listEntries": { value: typeof D["projects.listEntries"]['successSchema']; error: typeof D["projects.listEntries"]['errorSchema']; kind: 'result' }
  "projects.listIgnoredFiles": { value: typeof D["projects.listIgnoredFiles"]['successSchema']; error: typeof D["projects.listIgnoredFiles"]['errorSchema']; kind: 'result' }
  "projects.readFile": { value: typeof D["projects.readFile"]['successSchema']; error: typeof D["projects.readFile"]['errorSchema']; kind: 'result' }
  "projects.searchContents": { value: typeof D["projects.searchContents"]['successSchema']; error: typeof D["projects.searchContents"]['errorSchema']; kind: 'result' }
  "projects.searchEntries": { value: typeof D["projects.searchEntries"]['successSchema']; error: typeof D["projects.searchEntries"]['errorSchema']; kind: 'result' }
  "projects.ensureScratch": { value: typeof D["projects.ensureScratch"]['successSchema']; error: typeof D["projects.ensureScratch"]['errorSchema']; kind: 'result' }
  "projects.createNew": { value: typeof D["projects.createNew"]['successSchema']; error: typeof D["projects.createNew"]['errorSchema']; kind: 'result' }
  "projects.createFromThread": { value: typeof D["projects.createFromThread"]['successSchema']; error: typeof D["projects.createFromThread"]['errorSchema']; kind: 'result' }
  "projects.writeFile": { value: typeof D["projects.writeFile"]['successSchema']; error: typeof D["projects.writeFile"]['errorSchema']; kind: 'result' }
  "projects.mutate": { value: typeof D["projects.mutate"]['successSchema']; error: typeof D["projects.mutate"]['errorSchema']; kind: 'result' }
  "filesystem.browse": { value: typeof D["filesystem.browse"]['successSchema']; error: typeof D["filesystem.browse"]['errorSchema']; kind: 'result' }
  "filesystem.getMetadata": { value: typeof D["filesystem.getMetadata"]['successSchema']; error: typeof D["filesystem.getMetadata"]['errorSchema']; kind: 'result' }
  "assets.createUrl": { value: typeof D["assets.createUrl"]['successSchema']; error: typeof D["assets.createUrl"]['errorSchema']; kind: 'result' }
  "attachments.createUploadUrl": { value: typeof D["attachments.createUploadUrl"]['successSchema']; error: typeof D["attachments.createUploadUrl"]['errorSchema']; kind: 'result' }
  "attachments.delete": { value: typeof D["attachments.delete"]['successSchema']; error: typeof D["attachments.delete"]['errorSchema']; kind: 'result' }
  "mcpApps.callTool": { value: typeof D["mcpApps.callTool"]['successSchema']; error: typeof D["mcpApps.callTool"]['errorSchema']; kind: 'result' }
  "mcpApps.toolInfo": { value: typeof D["mcpApps.toolInfo"]['successSchema']; error: typeof D["mcpApps.toolInfo"]['errorSchema']; kind: 'result' }
  "mcpApps.readResource": { value: typeof D["mcpApps.readResource"]['successSchema']; error: typeof D["mcpApps.readResource"]['errorSchema']; kind: 'result' }
  "mcpApps.updateModelContext": { value: typeof D["mcpApps.updateModelContext"]['successSchema']; error: typeof D["mcpApps.updateModelContext"]['errorSchema']; kind: 'result' }
  "subscribeVcsStatus": { value: typeof D["subscribeVcsStatus"]['successSchema']['success']; error: typeof D["subscribeVcsStatus"]['errorSchema'] | typeof D["subscribeVcsStatus"]['successSchema']['error']; kind: 'stream' }
  "subscribeWorktreeSetup": { value: typeof D["subscribeWorktreeSetup"]['successSchema']['success']; error: typeof D["subscribeWorktreeSetup"]['errorSchema'] | typeof D["subscribeWorktreeSetup"]['successSchema']['error']; kind: 'stream' }
  "worktreeSetup.cancel": { value: typeof D["worktreeSetup.cancel"]['successSchema']; error: typeof D["worktreeSetup.cancel"]['errorSchema']; kind: 'result' }
  "vcs.pull": { value: typeof D["vcs.pull"]['successSchema']; error: typeof D["vcs.pull"]['errorSchema']; kind: 'result' }
  "vcs.refreshStatus": { value: typeof D["vcs.refreshStatus"]['successSchema']; error: typeof D["vcs.refreshStatus"]['errorSchema']; kind: 'result' }
  "git.runStackedAction": { value: typeof D["git.runStackedAction"]['successSchema']['success']; error: typeof D["git.runStackedAction"]['errorSchema'] | typeof D["git.runStackedAction"]['successSchema']['error']; kind: 'stream' }
  "git.resolvePullRequest": { value: typeof D["git.resolvePullRequest"]['successSchema']; error: typeof D["git.resolvePullRequest"]['errorSchema']; kind: 'result' }
  "git.preparePullRequestThread": { value: typeof D["git.preparePullRequestThread"]['successSchema']; error: typeof D["git.preparePullRequestThread"]['errorSchema']; kind: 'result' }
  "vcs.listRefs": { value: typeof D["vcs.listRefs"]['successSchema']; error: typeof D["vcs.listRefs"]['errorSchema']; kind: 'result' }
  "vcs.createWorktree": { value: typeof D["vcs.createWorktree"]['successSchema']; error: typeof D["vcs.createWorktree"]['errorSchema']; kind: 'result' }
  "vcs.removeWorktree": { value: typeof D["vcs.removeWorktree"]['successSchema']; error: typeof D["vcs.removeWorktree"]['errorSchema']; kind: 'result' }
  "vcs.createRef": { value: typeof D["vcs.createRef"]['successSchema']; error: typeof D["vcs.createRef"]['errorSchema']; kind: 'result' }
  "vcs.switchRef": { value: typeof D["vcs.switchRef"]['successSchema']; error: typeof D["vcs.switchRef"]['errorSchema']; kind: 'result' }
  "vcs.init": { value: typeof D["vcs.init"]['successSchema']; error: typeof D["vcs.init"]['errorSchema']; kind: 'result' }
  "review.getBranchCommits": { value: typeof D["review.getBranchCommits"]['successSchema']; error: typeof D["review.getBranchCommits"]['errorSchema']; kind: 'result' }
  "review.getDiffPreview": { value: typeof D["review.getDiffPreview"]['successSchema']; error: typeof D["review.getDiffPreview"]['errorSchema']; kind: 'result' }
  "review.getDiffFileContents": { value: typeof D["review.getDiffFileContents"]['successSchema']; error: typeof D["review.getDiffFileContents"]['errorSchema']; kind: 'result' }
  "terminal.open": { value: typeof D["terminal.open"]['successSchema']; error: typeof D["terminal.open"]['errorSchema']; kind: 'result' }
  "terminal.attach": { value: typeof D["terminal.attach"]['successSchema']['success']; error: typeof D["terminal.attach"]['errorSchema'] | typeof D["terminal.attach"]['successSchema']['error']; kind: 'stream' }
  "terminal.observe": { value: typeof D["terminal.observe"]['successSchema']['success']; error: typeof D["terminal.observe"]['errorSchema'] | typeof D["terminal.observe"]['successSchema']['error']; kind: 'stream' }
  "terminal.write": { value: typeof D["terminal.write"]['successSchema']; error: typeof D["terminal.write"]['errorSchema']; kind: 'result' }
  "terminal.resize": { value: typeof D["terminal.resize"]['successSchema']; error: typeof D["terminal.resize"]['errorSchema']; kind: 'result' }
  "terminal.clear": { value: typeof D["terminal.clear"]['successSchema']; error: typeof D["terminal.clear"]['errorSchema']; kind: 'result' }
  "terminal.close": { value: typeof D["terminal.close"]['successSchema']; error: typeof D["terminal.close"]['errorSchema']; kind: 'result' }
  "subscribeTerminalMetadata": { value: typeof D["subscribeTerminalMetadata"]['successSchema']['success']; error: typeof D["subscribeTerminalMetadata"]['errorSchema'] | typeof D["subscribeTerminalMetadata"]['successSchema']['error']; kind: 'stream' }
  "subscribeServerConfig": { value: typeof D["subscribeServerConfig"]['successSchema']['success']; error: typeof D["subscribeServerConfig"]['errorSchema'] | typeof D["subscribeServerConfig"]['successSchema']['error']; kind: 'stream' }
  "subscribeServerLifecycle": { value: typeof D["subscribeServerLifecycle"]['successSchema']['success']; error: typeof D["subscribeServerLifecycle"]['errorSchema'] | typeof D["subscribeServerLifecycle"]['successSchema']['error']; kind: 'stream' }
  "subscribeAuthAccess": { value: typeof D["subscribeAuthAccess"]['successSchema']['success']; error: typeof D["subscribeAuthAccess"]['errorSchema'] | typeof D["subscribeAuthAccess"]['successSchema']['error']; kind: 'stream' }
  "orchestration.dispatchCommand": { value: typeof D["orchestration.dispatchCommand"]['successSchema']; error: typeof D["orchestration.dispatchCommand"]['errorSchema']; kind: 'result' }
  "orchestration.getWorkflowScript": { value: typeof D["orchestration.getWorkflowScript"]['successSchema']; error: typeof D["orchestration.getWorkflowScript"]['errorSchema']; kind: 'result' }
  "orchestration.getNativeChildWork": { value: typeof D["orchestration.getNativeChildWork"]['successSchema']; error: typeof D["orchestration.getNativeChildWork"]['errorSchema']; kind: 'result' }
  "orchestration.stopWorkflow": { value: typeof D["orchestration.stopWorkflow"]['successSchema']; error: typeof D["orchestration.stopWorkflow"]['errorSchema']; kind: 'result' }
  "orchestration.forceStopThread": { value: typeof D["orchestration.forceStopThread"]['successSchema']; error: typeof D["orchestration.forceStopThread"]['errorSchema']; kind: 'result' }
  "orchestration.getTurnItem": { value: typeof D["orchestration.getTurnItem"]['successSchema']; error: typeof D["orchestration.getTurnItem"]['errorSchema']; kind: 'result' }
  "orchestration.getTurnDiff": { value: typeof D["orchestration.getTurnDiff"]['successSchema']; error: typeof D["orchestration.getTurnDiff"]['errorSchema']; kind: 'result' }
  "orchestration.getFullThreadDiff": { value: typeof D["orchestration.getFullThreadDiff"]['successSchema']; error: typeof D["orchestration.getFullThreadDiff"]['errorSchema']; kind: 'result' }
  "orchestration.searchThreads": { value: typeof D["orchestration.searchThreads"]['successSchema']; error: typeof D["orchestration.searchThreads"]['errorSchema']; kind: 'result' }
  "orchestration.searchThread": { value: typeof D["orchestration.searchThread"]['successSchema']; error: typeof D["orchestration.searchThread"]['errorSchema']; kind: 'result' }
  "orchestration.searchThreadStream": { value: typeof D["orchestration.searchThreadStream"]['successSchema']['success']; error: typeof D["orchestration.searchThreadStream"]['errorSchema'] | typeof D["orchestration.searchThreadStream"]['successSchema']['error']; kind: 'stream' }
  "orchestration.getArchivedShellSnapshot": { value: typeof D["orchestration.getArchivedShellSnapshot"]['successSchema']; error: typeof D["orchestration.getArchivedShellSnapshot"]['errorSchema']; kind: 'result' }
  "orchestration.getThreadFamily": { value: typeof D["orchestration.getThreadFamily"]['successSchema']; error: typeof D["orchestration.getThreadFamily"]['errorSchema']; kind: 'result' }
  "orchestration.getThreadTitles": { value: typeof D["orchestration.getThreadTitles"]['successSchema']; error: typeof D["orchestration.getThreadTitles"]['errorSchema']; kind: 'result' }
  "orchestration.getWorktreeThreadIds": { value: typeof D["orchestration.getWorktreeThreadIds"]['successSchema']; error: typeof D["orchestration.getWorktreeThreadIds"]['errorSchema']; kind: 'result' }
  "orchestration.getOlderSettledThreads": { value: typeof D["orchestration.getOlderSettledThreads"]['successSchema']; error: typeof D["orchestration.getOlderSettledThreads"]['errorSchema']; kind: 'result' }
  "orchestration.getThreadProjection": { value: typeof D["orchestration.getThreadProjection"]['successSchema']; error: typeof D["orchestration.getThreadProjection"]['errorSchema']; kind: 'result' }
  "orchestration.launchThread": { value: typeof D["orchestration.launchThread"]['successSchema']; error: typeof D["orchestration.launchThread"]['errorSchema']; kind: 'result' }
  "orchestration.subscribeShell": { value: typeof D["orchestration.subscribeShell"]['successSchema']['success']; error: typeof D["orchestration.subscribeShell"]['errorSchema'] | typeof D["orchestration.subscribeShell"]['successSchema']['error']; kind: 'stream' }
  "orchestration.subscribeThread": { value: typeof D["orchestration.subscribeThread"]['successSchema']['success']; error: typeof D["orchestration.subscribeThread"]['errorSchema'] | typeof D["orchestration.subscribeThread"]['successSchema']['error']; kind: 'stream' }
  "orchestration.subscribeCommandOutput": { value: typeof D["orchestration.subscribeCommandOutput"]['successSchema']['success']; error: typeof D["orchestration.subscribeCommandOutput"]['errorSchema'] | typeof D["orchestration.subscribeCommandOutput"]['successSchema']['error']; kind: 'stream' }
}
type Reply<M extends ExecutorT3Method> = Replies[M]
type Value<M extends ExecutorT3Method> = Reply<M>['value']
type Failure<M extends ExecutorT3Method> = Reply<M>['error']
type Kind<M extends ExecutorT3Method> = Reply<M>['kind']
export type ExecutorT3Result = { [M in ExecutorT3Method]: ExecutorT3Routing & {
  readonly kind: Kind<M>; readonly method: M; readonly result: Value<M>['Type']
} }[ExecutorT3Method]
export type ExecutorT3ResultEncoded = { [M in ExecutorT3Method]: typeof ExecutorT3Routing.Encoded & {
  readonly kind: Kind<M>; readonly method: M; readonly result: Value<M>['Encoded']
} }[ExecutorT3Method]
export type ExecutorT3Error = { [M in ExecutorT3Method]: ExecutorT3Routing & {
  readonly kind: 'error'; readonly method: M; readonly error: Failure<M>['Type']
} }[ExecutorT3Method]
export type ExecutorT3ErrorEncoded = { [M in ExecutorT3Method]: typeof ExecutorT3Routing.Encoded & {
  readonly kind: 'error'; readonly method: M; readonly error: Failure<M>['Encoded']
} }[ExecutorT3Method]
export const ExecutorT3Result: Schema.Codec<ExecutorT3Result, ExecutorT3ResultEncoded> = Schema.Union([
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("server.probe"), result: D["server.probe"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("server.getConfig"), result: D["server.getConfig"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("server.refreshProviders"), result: D["server.refreshProviders"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("server.updateSettings"), result: D["server.updateSettings"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("peerLinks.list"), result: D["peerLinks.list"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('stream'), method: Schema.Literal("scheduledTasks.subscribe"), result: D["scheduledTasks.subscribe"].successSchema.success }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("scheduledTasks.upsert"), result: D["scheduledTasks.upsert"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("scheduledTasks.setEnabled"), result: D["scheduledTasks.setEnabled"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("scheduledTasks.delete"), result: D["scheduledTasks.delete"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("scheduledTasks.runNow"), result: D["scheduledTasks.runNow"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("projects.listEntries"), result: D["projects.listEntries"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("projects.listIgnoredFiles"), result: D["projects.listIgnoredFiles"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("projects.readFile"), result: D["projects.readFile"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("projects.searchContents"), result: D["projects.searchContents"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("projects.searchEntries"), result: D["projects.searchEntries"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("projects.ensureScratch"), result: D["projects.ensureScratch"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("projects.createNew"), result: D["projects.createNew"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("projects.createFromThread"), result: D["projects.createFromThread"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("projects.writeFile"), result: D["projects.writeFile"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("projects.mutate"), result: D["projects.mutate"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("filesystem.browse"), result: D["filesystem.browse"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("filesystem.getMetadata"), result: D["filesystem.getMetadata"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("assets.createUrl"), result: D["assets.createUrl"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("attachments.createUploadUrl"), result: D["attachments.createUploadUrl"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("attachments.delete"), result: D["attachments.delete"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("mcpApps.callTool"), result: D["mcpApps.callTool"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("mcpApps.toolInfo"), result: D["mcpApps.toolInfo"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("mcpApps.readResource"), result: D["mcpApps.readResource"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("mcpApps.updateModelContext"), result: D["mcpApps.updateModelContext"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('stream'), method: Schema.Literal("subscribeVcsStatus"), result: D["subscribeVcsStatus"].successSchema.success }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('stream'), method: Schema.Literal("subscribeWorktreeSetup"), result: D["subscribeWorktreeSetup"].successSchema.success }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("worktreeSetup.cancel"), result: D["worktreeSetup.cancel"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("vcs.pull"), result: D["vcs.pull"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("vcs.refreshStatus"), result: D["vcs.refreshStatus"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('stream'), method: Schema.Literal("git.runStackedAction"), result: D["git.runStackedAction"].successSchema.success }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("git.resolvePullRequest"), result: D["git.resolvePullRequest"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("git.preparePullRequestThread"), result: D["git.preparePullRequestThread"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("vcs.listRefs"), result: D["vcs.listRefs"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("vcs.createWorktree"), result: D["vcs.createWorktree"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("vcs.removeWorktree"), result: D["vcs.removeWorktree"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("vcs.createRef"), result: D["vcs.createRef"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("vcs.switchRef"), result: D["vcs.switchRef"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("vcs.init"), result: D["vcs.init"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("review.getBranchCommits"), result: D["review.getBranchCommits"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("review.getDiffPreview"), result: D["review.getDiffPreview"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("review.getDiffFileContents"), result: D["review.getDiffFileContents"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("terminal.open"), result: D["terminal.open"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('stream'), method: Schema.Literal("terminal.attach"), result: D["terminal.attach"].successSchema.success }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('stream'), method: Schema.Literal("terminal.observe"), result: D["terminal.observe"].successSchema.success }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("terminal.write"), result: D["terminal.write"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("terminal.resize"), result: D["terminal.resize"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("terminal.clear"), result: D["terminal.clear"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("terminal.close"), result: D["terminal.close"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('stream'), method: Schema.Literal("subscribeTerminalMetadata"), result: D["subscribeTerminalMetadata"].successSchema.success }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('stream'), method: Schema.Literal("subscribeServerConfig"), result: D["subscribeServerConfig"].successSchema.success }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('stream'), method: Schema.Literal("subscribeServerLifecycle"), result: D["subscribeServerLifecycle"].successSchema.success }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('stream'), method: Schema.Literal("subscribeAuthAccess"), result: D["subscribeAuthAccess"].successSchema.success }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("orchestration.dispatchCommand"), result: D["orchestration.dispatchCommand"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("orchestration.getWorkflowScript"), result: D["orchestration.getWorkflowScript"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("orchestration.getNativeChildWork"), result: D["orchestration.getNativeChildWork"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("orchestration.stopWorkflow"), result: D["orchestration.stopWorkflow"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("orchestration.forceStopThread"), result: D["orchestration.forceStopThread"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("orchestration.getTurnItem"), result: D["orchestration.getTurnItem"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("orchestration.getTurnDiff"), result: D["orchestration.getTurnDiff"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("orchestration.getFullThreadDiff"), result: D["orchestration.getFullThreadDiff"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("orchestration.searchThreads"), result: D["orchestration.searchThreads"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("orchestration.searchThread"), result: D["orchestration.searchThread"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('stream'), method: Schema.Literal("orchestration.searchThreadStream"), result: D["orchestration.searchThreadStream"].successSchema.success }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("orchestration.getArchivedShellSnapshot"), result: D["orchestration.getArchivedShellSnapshot"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("orchestration.getThreadFamily"), result: D["orchestration.getThreadFamily"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("orchestration.getThreadTitles"), result: D["orchestration.getThreadTitles"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("orchestration.getWorktreeThreadIds"), result: D["orchestration.getWorktreeThreadIds"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("orchestration.getOlderSettledThreads"), result: D["orchestration.getOlderSettledThreads"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("orchestration.getThreadProjection"), result: D["orchestration.getThreadProjection"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('result'), method: Schema.Literal("orchestration.launchThread"), result: D["orchestration.launchThread"].successSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('stream'), method: Schema.Literal("orchestration.subscribeShell"), result: D["orchestration.subscribeShell"].successSchema.success }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('stream'), method: Schema.Literal("orchestration.subscribeThread"), result: D["orchestration.subscribeThread"].successSchema.success }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('stream'), method: Schema.Literal("orchestration.subscribeCommandOutput"), result: D["orchestration.subscribeCommandOutput"].successSchema.success }),
])
export const ExecutorT3Error: Schema.Codec<ExecutorT3Error, ExecutorT3ErrorEncoded> = Schema.Union([
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("server.probe"), error: D["server.probe"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("server.getConfig"), error: D["server.getConfig"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("server.refreshProviders"), error: D["server.refreshProviders"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("server.updateSettings"), error: D["server.updateSettings"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("peerLinks.list"), error: D["peerLinks.list"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("scheduledTasks.subscribe"), error: Schema.Union([D["scheduledTasks.subscribe"].errorSchema, D["scheduledTasks.subscribe"].successSchema.error]) }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("scheduledTasks.upsert"), error: D["scheduledTasks.upsert"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("scheduledTasks.setEnabled"), error: D["scheduledTasks.setEnabled"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("scheduledTasks.delete"), error: D["scheduledTasks.delete"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("scheduledTasks.runNow"), error: D["scheduledTasks.runNow"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("projects.listEntries"), error: D["projects.listEntries"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("projects.listIgnoredFiles"), error: D["projects.listIgnoredFiles"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("projects.readFile"), error: D["projects.readFile"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("projects.searchContents"), error: D["projects.searchContents"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("projects.searchEntries"), error: D["projects.searchEntries"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("projects.ensureScratch"), error: D["projects.ensureScratch"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("projects.createNew"), error: D["projects.createNew"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("projects.createFromThread"), error: D["projects.createFromThread"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("projects.writeFile"), error: D["projects.writeFile"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("projects.mutate"), error: D["projects.mutate"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("filesystem.browse"), error: D["filesystem.browse"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("filesystem.getMetadata"), error: D["filesystem.getMetadata"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("assets.createUrl"), error: D["assets.createUrl"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("attachments.createUploadUrl"), error: D["attachments.createUploadUrl"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("attachments.delete"), error: D["attachments.delete"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("mcpApps.callTool"), error: D["mcpApps.callTool"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("mcpApps.toolInfo"), error: D["mcpApps.toolInfo"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("mcpApps.readResource"), error: D["mcpApps.readResource"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("mcpApps.updateModelContext"), error: D["mcpApps.updateModelContext"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("subscribeVcsStatus"), error: Schema.Union([D["subscribeVcsStatus"].errorSchema, D["subscribeVcsStatus"].successSchema.error]) }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("subscribeWorktreeSetup"), error: Schema.Union([D["subscribeWorktreeSetup"].errorSchema, D["subscribeWorktreeSetup"].successSchema.error]) }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("worktreeSetup.cancel"), error: D["worktreeSetup.cancel"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("vcs.pull"), error: D["vcs.pull"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("vcs.refreshStatus"), error: D["vcs.refreshStatus"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("git.runStackedAction"), error: Schema.Union([D["git.runStackedAction"].errorSchema, D["git.runStackedAction"].successSchema.error]) }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("git.resolvePullRequest"), error: D["git.resolvePullRequest"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("git.preparePullRequestThread"), error: D["git.preparePullRequestThread"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("vcs.listRefs"), error: D["vcs.listRefs"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("vcs.createWorktree"), error: D["vcs.createWorktree"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("vcs.removeWorktree"), error: D["vcs.removeWorktree"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("vcs.createRef"), error: D["vcs.createRef"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("vcs.switchRef"), error: D["vcs.switchRef"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("vcs.init"), error: D["vcs.init"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("review.getBranchCommits"), error: D["review.getBranchCommits"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("review.getDiffPreview"), error: D["review.getDiffPreview"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("review.getDiffFileContents"), error: D["review.getDiffFileContents"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("terminal.open"), error: D["terminal.open"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("terminal.attach"), error: Schema.Union([D["terminal.attach"].errorSchema, D["terminal.attach"].successSchema.error]) }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("terminal.observe"), error: Schema.Union([D["terminal.observe"].errorSchema, D["terminal.observe"].successSchema.error]) }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("terminal.write"), error: D["terminal.write"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("terminal.resize"), error: D["terminal.resize"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("terminal.clear"), error: D["terminal.clear"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("terminal.close"), error: D["terminal.close"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("subscribeTerminalMetadata"), error: Schema.Union([D["subscribeTerminalMetadata"].errorSchema, D["subscribeTerminalMetadata"].successSchema.error]) }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("subscribeServerConfig"), error: Schema.Union([D["subscribeServerConfig"].errorSchema, D["subscribeServerConfig"].successSchema.error]) }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("subscribeServerLifecycle"), error: Schema.Union([D["subscribeServerLifecycle"].errorSchema, D["subscribeServerLifecycle"].successSchema.error]) }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("subscribeAuthAccess"), error: Schema.Union([D["subscribeAuthAccess"].errorSchema, D["subscribeAuthAccess"].successSchema.error]) }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("orchestration.dispatchCommand"), error: D["orchestration.dispatchCommand"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("orchestration.getWorkflowScript"), error: D["orchestration.getWorkflowScript"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("orchestration.getNativeChildWork"), error: D["orchestration.getNativeChildWork"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("orchestration.stopWorkflow"), error: D["orchestration.stopWorkflow"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("orchestration.forceStopThread"), error: D["orchestration.forceStopThread"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("orchestration.getTurnItem"), error: D["orchestration.getTurnItem"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("orchestration.getTurnDiff"), error: D["orchestration.getTurnDiff"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("orchestration.getFullThreadDiff"), error: D["orchestration.getFullThreadDiff"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("orchestration.searchThreads"), error: D["orchestration.searchThreads"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("orchestration.searchThread"), error: D["orchestration.searchThread"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("orchestration.searchThreadStream"), error: Schema.Union([D["orchestration.searchThreadStream"].errorSchema, D["orchestration.searchThreadStream"].successSchema.error]) }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("orchestration.getArchivedShellSnapshot"), error: D["orchestration.getArchivedShellSnapshot"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("orchestration.getThreadFamily"), error: D["orchestration.getThreadFamily"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("orchestration.getThreadTitles"), error: D["orchestration.getThreadTitles"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("orchestration.getWorktreeThreadIds"), error: D["orchestration.getWorktreeThreadIds"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("orchestration.getOlderSettledThreads"), error: D["orchestration.getOlderSettledThreads"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("orchestration.getThreadProjection"), error: D["orchestration.getThreadProjection"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("orchestration.launchThread"), error: D["orchestration.launchThread"].errorSchema }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("orchestration.subscribeShell"), error: Schema.Union([D["orchestration.subscribeShell"].errorSchema, D["orchestration.subscribeShell"].successSchema.error]) }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("orchestration.subscribeThread"), error: Schema.Union([D["orchestration.subscribeThread"].errorSchema, D["orchestration.subscribeThread"].successSchema.error]) }),
  Schema.Struct({ ...ExecutorT3Routing.fields, kind: Schema.Literal('error'), method: Schema.Literal("orchestration.subscribeCommandOutput"), error: Schema.Union([D["orchestration.subscribeCommandOutput"].errorSchema, D["orchestration.subscribeCommandOutput"].successSchema.error]) }),
])
