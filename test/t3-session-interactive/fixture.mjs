import { EnvironmentId, ThreadId } from '@nessie/t3-session-source/contracts'

export const scope = {
  executorId: 'executor:fixture', environmentId: EnvironmentId.make('environment:雪/one'),
  threadId: ThreadId.make('mcp:thread/雪'), connectionEpoch: '9007199254740993',
  runtimeGeneration: 'runtime:one', access: 'operate',
  workspace: { cwd: 'C:/fixture workspace', worktreePath: 'C:/fixture workspace' },
  terminals: ['term:one', 'term:two'], tabs: ['tab:one'],
  devices: [{ hostId: 'local', deviceId: 'device:one', platform: 'ios' }],
}
export const snapshot = {
  threadId: scope.threadId, terminalId: scope.terminals[0], ...scope.workspace,
  status: 'running', pid: 123, history: 'synthetic output\r\n', exitCode: null, exitSignal: null,
  label: 'shell', updatedAt: '2026-11-08T00:00:00.000Z', sequence: 20, cols: 120, rows: 30,
}
