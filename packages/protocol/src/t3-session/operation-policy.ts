import type { ExecutorT3Method } from './methods.js'
import type { ExecutorT3Request } from './request.js'
import ledger from './ledger.json' with { type: 'json' }

export type ExecutorT3ReceiptPolicy =
  | 'none' | 'conditional-provider-session' | 'durable-command-or-delivery' | 'conditional-refresh'

const refsRefreshPolicy = {
  when: { field: 'refresh', equals: true },
  admission: 'mutation', receipt: 'durable-command-or-delivery',
} as const

/** Input policy metadata shared by gateway and tool surfaces. It grants no authority. */
export const executorT3RpcOperationPolicy = (method: ExecutorT3Method) => {
  const rule = ledger.rpc[method]
  return {
    authority: rule.authority as 'read' | 'owner' | 'operate',
    receipt: (method === 'vcs.listRefs' ? 'conditional-refresh' : rule.receipt) as ExecutorT3ReceiptPolicy,
    inputPolicies: method === 'vcs.listRefs' ? [refsRefreshPolicy] : [],
    annotations: { readOnlyHint: method !== 'vcs.listRefs' && rule.receipt === 'none' },
  }
}

type PolicyRequest<R> = R extends ExecutorT3Request ? Pick<R, 'method' | 'input'> : never

/** Call after the original codec has decoded input; owner and target admission remain mandatory. */
export const executorT3RpcInputPolicy = (request: PolicyRequest<ExecutorT3Request>) => {
  const operation = executorT3RpcOperationPolicy(request.method)
  if (request.method !== 'vcs.listRefs') return { ...operation, admission: 'ledger' as const }
  return request.input.refresh === true
    ? { ...operation, receipt: refsRefreshPolicy.receipt, admission: refsRefreshPolicy.admission }
    : { ...operation, receipt: 'none' as const, admission: 'read' as const }
}
