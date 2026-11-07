// Inserted into the pinned shared registry by the hash-bound compatibility patch.
// These are registered identities, not the presentation parser's loose aliases.
const SECRET_REQUEST_TOOL_IDS: ReadonlySet<string> = new Set(
  [...T3_MCP_SERVER_ALIASES].flatMap((server) => [
    `${server}.request_secret`,
    `mcp__${server}__request_secret`,
  ]),
);
const PRIVATE_REQUEST_VALUE = "[REDACTED]";
const PRIVATE_REQUEST_FIELDS = new Set([
  "value", "secret", "input", "arguments", "output", "result", "error", "content",
  "structuredContent", "contentItems", "message", "text", "preview", "updatedInput",
  "answer", "answers", "initialValue", "default", "defaultValue",
]);
const PUBLIC_REQUEST_METADATA = new Set([
  "id", "call_id", "tool_use_id", "type", "toolName", "name", "server", "tool", "namespace",
  "status", "success", "is_error", "isError", "threadId", "turnId", "requestId", "runId",
  "providerSessionId", "providerThreadId", "providerTurnId", "nativeItemRef", "driver", "nativeId",
  "strength", "ordinal", "fieldOrdinal", "answerOrdinal", "method", "jsonrpc", "direction", "stage",
]);

function requestPrivacyRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function isSecretRequestTool(toolName: unknown): boolean {
  return typeof toolName === "string" && SECRET_REQUEST_TOOL_IDS.has(toolName);
}

/** Never turn a masked question into an ordinary persisted answer. T13 owns the real port. */
export function assertPublicUserInputQuestions(questions: unknown): void {
  if (Array.isArray(questions) && questions.some((question) =>
    requestPrivacyRecord(question)?.isSecret === true)) {
    throw new Error("canonical_secret_question_port_required");
  }
}

/** Projection only: the authorized operation receives the untouched original input. */
export function projectSecretRequestInput(toolName: unknown, input: unknown): unknown {
  if (!isSecretRequestTool(toolName)) return input;
  const fields = requestPrivacyRecord(input);
  if (fields === undefined) return PRIVATE_REQUEST_VALUE;
  // Unknown/malformed fields must not be echoed by a schema failure or preview.
  const publicFields = new Set(["label", "reason", "placeholder", "delivery", "timeoutMs", "clientRequestId"]);
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [
    key, publicFields.has(key) && (typeof value === "string" || typeof value === "number")
      ? value : PRIVATE_REQUEST_VALUE,
  ]));
}

export function projectSecretRequestOutput(toolName: unknown, output: unknown): unknown {
  return output === undefined || !isSecretRequestTool(toolName) ? output : PRIVATE_REQUEST_VALUE;
}

export function projectSecretRequestItem<T extends {
  readonly toolName?: string | null;
  readonly input?: unknown;
  readonly output?: unknown;
}>(item: T): T {
  return !isSecretRequestTool(item.toolName) ? item : {
    ...item,
    title: "Request a secret",
    input: projectSecretRequestInput(item.toolName, item.input),
    ...(item.output === undefined ? {} : { output: PRIVATE_REQUEST_VALUE }),
  };
}

/**
 * A logger-local projector retains only opaque call IDs. Two passes correlate mixed frames
 * and replays, including results preceding calls in a batch. No supplied value is retained.
 * SDK-owned transcripts and arbitrary prose are outside this structured boundary.
 */
export function createRequestPrivacyProjector(): (value: unknown) => unknown {
  const privateCalls = new Set<string>();
  const privateQuestions = new Set<string>();
  let exhausted = false;
  const remember = (id: unknown) => {
    if (typeof id !== "string" && typeof id !== "number") return;
    if (privateCalls.size >= 8192) { exhausted = true; return; }
    privateCalls.add(`${typeof id}:${id}`);
  };
  const remembered = (id: unknown) => privateCalls.has(`${typeof id}:${String(id)}`);
  const identity = (record: Record<string, unknown>): unknown => {
    if (typeof record.server === "string" && typeof record.tool === "string") {
      return `${record.server}.${record.tool}`;
    }
    if (typeof record.namespace === "string" && typeof record.tool === "string") {
      return `${record.namespace}.${record.tool}`;
    }
    return record.toolName ?? record.name;
  };
  return (value) => {
    if (exhausted) return { privacy: "request_projection_unavailable" };
    let remaining = 32768;
    const ancestors = new WeakSet<object>();
    const scan = (value: unknown, depth: number): void => {
      if (value === null || typeof value !== "object") return;
      if (depth > 64 || --remaining < 0 || ancestors.has(value)) { exhausted = true; return; }
      ancestors.add(value);
      if (Array.isArray(value)) {
        for (const item of value) scan(item, depth + 1);
      } else {
        const record = value as Record<string, unknown>;
        const params = requestPrivacyRecord(record.params);
        const own = isSecretRequestTool(identity(record));
        const rpc = record.method === "tools/call" && params !== undefined && (
          isSecretRequestTool(identity(params)) ||
          (T3_MCP_SERVER_ALIASES.has(String(record.server)) && params.name === "request_secret")
        );
        if (own || rpc) {
          remember(record.id); remember(record.call_id); remember(record.tool_use_id);
        }
        if (record.isSecret === true && typeof record.id === "string") {
          if (privateQuestions.size >= 8192) exhausted = true;
          else privateQuestions.add(record.id);
        }
        for (const nested of Object.values(record)) scan(nested, depth + 1);
      }
      ancestors.delete(value);
    };
    try { scan(value, 0); } catch { exhausted = true; }
    // Fail closed on traversal/correlation exhaustion, never fall back to the raw record.
    if (exhausted) return { privacy: "request_projection_unavailable" };
    const project = (value: unknown, depth: number): unknown => {
      if (value === null || typeof value !== "object") return value;
      if (Array.isArray(value)) return value.map((item) => project(item, depth + 1));
      const record = value as Record<string, unknown>;
      const params = requestPrivacyRecord(record.params);
      const tool = identity(record);
      const secret = isSecretRequestTool(tool);
      const correlated = remembered(record.id) || remembered(record.call_id) || remembered(record.tool_use_id);
      const rpc = record.method === "tools/call" && params !== undefined && (
        isSecretRequestTool(identity(params)) ||
        (T3_MCP_SERVER_ALIASES.has(String(record.server)) && params.name === "request_secret")
      );
      const masked = record.isSecret === true;
      return Object.fromEntries(Object.entries(record).map(([key, nested]) => {
        if (!secret && !correlated && !masked && key === "answers" && requestPrivacyRecord(nested) !== undefined) {
          return [key, Object.fromEntries(Object.entries(nested as Record<string, unknown>).map(([id, answer]) => [
            id, privateQuestions.has(id) ? PRIVATE_REQUEST_VALUE : project(answer, depth + 1),
          ]))];
        }
        if (secret && (key === "input" || key === "arguments")) {
          return [key, projectSecretRequestInput(tool, nested)];
        }
        if (rpc && key === "params") {
          return [key, Object.fromEntries(Object.entries(params!).map(([field, argument]) => [
            field, field === "arguments" ? projectSecretRequestInput("t3-code.request_secret", argument)
              : PUBLIC_REQUEST_METADATA.has(field) ? argument : PRIVATE_REQUEST_VALUE,
          ]))];
        }
        if (((secret || correlated) && !PUBLIC_REQUEST_METADATA.has(key)) ||
          (masked && PRIVATE_REQUEST_FIELDS.has(key))) {
          return [key, PRIVATE_REQUEST_VALUE];
        }
        return [key, project(nested, depth + 1)];
      }));
    };
    try { return project(value, 0); } catch { return { privacy: "request_projection_unavailable" }; }
  };
}
