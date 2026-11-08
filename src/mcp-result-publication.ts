import { settleExecutorMcpImages, type ExecutorMcpImageSink } from './mcp-images.js'

export type ExecutorMcpCallGuard = {
  prepareMeta: () => Promise<Record<string, unknown>>
  validateResult: (result: Record<string, unknown>) => Promise<Record<string, unknown>>
}

/** Validation precedes every image sink and the returned command document. */
export const publishExecutorMcpResult = async (
  result: Record<string, unknown>, input: { server: string; tool: string; maxResultBytes: number;
    images?: ExecutorMcpImageSink; log: (message: string, error?: unknown) => void;
    validate?: (result: Record<string, unknown>) => Promise<Record<string, unknown>> },
): Promise<Record<string, unknown>> => {
  if (input.validate) {
    try { result = await input.validate(result) }
    catch { return { code: 'EXECUTOR_CODING_SESSION_RESULT_WITHHELD',
      message: 'Original session result authority is unavailable.', success: false } }
  }
  const settled = await settleExecutorMcpImages(result, input.images, input.log)
  const document: Record<string, unknown> = settled.isError === true
    ? { ...settled, code: 'EXECUTOR_MCP_CALL_FAILED', success: false } : { ...settled, success: true }
  const resultBytes = Buffer.byteLength(JSON.stringify(document))
  if (resultBytes > input.maxResultBytes) return { code: 'EXECUTOR_MCP_RESULT_TOO_LARGE',
    maxResultBytes: input.maxResultBytes, resultBytes, success: false,
    message: `The MCP server "${input.server}" answered with ${resultBytes} bytes, over the ${input.maxResultBytes}-byte result budget.` }
  return document
}
