// Inserted into the pinned registry by the hash-bound compatibility patch.
const SECRET_REQUEST_TOOL_IDS: ReadonlySet<string> = new Set(
  [...T3_MCP_SERVER_ALIASES].flatMap((server) => [
    `${server}.request_secret`, `mcp__${server}__request_secret`,
  ]),
);
const PRIVATE_REQUEST_VALUE = "[REDACTED]";
const REQUEST_PRIVACY_UNAVAILABLE = { privacy: "request_projection_unavailable" };
const REQUEST_PRIVACY_LIMIT = Symbol("request privacy limit");
const PRIVATE_REQUEST_FIELDS = new Set([
  "value", "secret", "input", "arguments", "output", "result", "error", "content",
  "structuredContent", "contentItems", "message", "text", "preview", "updatedInput",
  "answer", "answers", "initialValue", "initialAnswer", "default", "defaultValue",
]);
const REQUEST_ID_FIELDS = ["id", "callId", "call_id", "tool_use_id"] as const;
const REQUEST_STRING_METADATA = new Set([
  "type", "toolName", "name", "server", "tool", "namespace", "status", "threadId",
  "turnId", "requestId", "runId", "providerSessionId", "providerThreadId", "providerTurnId",
  "driver", "nativeId", "strength", "method", "jsonrpc", "direction", "stage",
]);
const REQUEST_BOOLEAN_METADATA = new Set(["success", "is_error", "isError", "isSecret"]);
const REQUEST_ORDINAL_METADATA = new Set(["ordinal", "fieldOrdinal", "answerOrdinal"]);

function requestPrivacyRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function requestPrivacyStringBytes(value: string, limit: number): number {
  if (value.length > limit) throw REQUEST_PRIVACY_LIMIT;
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4; index++;
    } else bytes += 3;
    if (bytes > limit) throw REQUEST_PRIVACY_LIMIT;
  }
  return bytes;
}

/** Capture data descriptors once; never invoke accessors or allocate an unbounded entries array. */
function captureRequestPrivacyValue(
  input: unknown, observe: (record: Record<string, unknown>) => void = () => {},
): unknown {
  let members = 32768;
  let bytes = 1024 * 1024;
  const ancestors = new WeakSet<object>();
  const chargeString = (value: string) => { bytes -= requestPrivacyStringBytes(value, bytes); };
  const visit = (value: unknown, depth: number): unknown => {
    if (--members < 0 || depth > 64) throw REQUEST_PRIVACY_LIMIT;
    if (typeof value === "string") { chargeString(value); return value; }
    if (value === null || value === undefined || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || ancestors.has(value)) throw REQUEST_PRIVACY_LIMIT;
    ancestors.add(value);
    if (Array.isArray(value)) {
      const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
      if (typeof length !== "number" || length > members) throw REQUEST_PRIVACY_LIMIT;
      const result: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (descriptor !== undefined && !("value" in descriptor)) throw REQUEST_PRIVACY_LIMIT;
        result.push(visit(descriptor?.value, depth + 1));
      }
      ancestors.delete(value);
      return result;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw REQUEST_PRIVACY_LIMIT;
    const result: Record<string, unknown> = {};
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      // Charge the member before inspecting it, even if its value is a primitive.
      if (members <= 0) throw REQUEST_PRIVACY_LIMIT;
      chargeString(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) throw REQUEST_PRIVACY_LIMIT;
      Object.defineProperty(result, key, {
        value: visit(descriptor.value, depth + 1), enumerable: true, configurable: true,
      });
    }
    ancestors.delete(value);
    observe(result);
    return result;
  };
  return visit(input, 0);
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

function projectCapturedSecretRequestInput(input: unknown): unknown {
  const fields = requestPrivacyRecord(input);
  if (fields === undefined) return PRIVATE_REQUEST_VALUE;
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => {
    const text = ["label", "reason", "placeholder", "clientRequestId"].includes(key) && typeof value === "string";
    const delivery = key === "delivery" && (value === "file" || value === "secretRef");
    const timeout = key === "timeoutMs" && typeof value === "number" && Number.isFinite(value) && value >= 0;
    return [key, text || delivery || timeout ? value : PRIVATE_REQUEST_VALUE];
  }));
}

/** Projection only: the authorized operation receives the untouched original input. */
export function projectSecretRequestInput(toolName: unknown, input: unknown): unknown {
  if (!isSecretRequestTool(toolName)) return input;
  try { return projectCapturedSecretRequestInput(captureRequestPrivacyValue(input)); }
  catch { return PRIVATE_REQUEST_VALUE; }
}

export function projectSecretRequestOutput(toolName: unknown, output: unknown): unknown {
  return output === undefined || !isSecretRequestTool(toolName) ? output : PRIVATE_REQUEST_VALUE;
}

export function projectSecretRequestItem<T extends {
  readonly toolName?: string | null; readonly input?: unknown; readonly output?: unknown;
}>(item: T): T {
  return !isSecretRequestTool(item.toolName) ? item : {
    ...item, title: "Request a secret", input: projectSecretRequestInput(item.toolName, item.input),
    ...(item.output === undefined ? {} : { output: PRIVATE_REQUEST_VALUE }),
  };
}

function requestPrivacyTool(record: Record<string, unknown>): string | undefined {
  const qualified = [record.toolName, record.name];
  if (typeof record.tool === "string") {
    if (typeof record.server === "string") qualified.push(`${record.server}.${record.tool}`);
    if (typeof record.namespace === "string") qualified.push(`${record.namespace}.${record.tool}`);
  }
  return qualified.find((name): name is string => typeof name === "string" && isSecretRequestTool(name));
}

function requestPrivacyMetadata(key: string, value: unknown): unknown {
  if (REQUEST_ID_FIELDS.some((field) => field === key)) {
    return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
      ? value : PRIVATE_REQUEST_VALUE;
  }
  if (REQUEST_STRING_METADATA.has(key)) return typeof value === "string" ? value : PRIVATE_REQUEST_VALUE;
  if (REQUEST_BOOLEAN_METADATA.has(key)) return typeof value === "boolean" ? value : PRIVATE_REQUEST_VALUE;
  if (REQUEST_ORDINAL_METADATA.has(key)) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : PRIVATE_REQUEST_VALUE;
  }
  if (key === "nativeItemRef") {
    const record = requestPrivacyRecord(value);
    if (record === undefined || Object.keys(record).some((field) =>
      !["driver", "nativeId", "strength"].includes(field) || typeof record[field] !== "string")) {
      return PRIVATE_REQUEST_VALUE;
    }
    return Object.fromEntries(Object.entries(record).map(([field, nested]) => [field, requestPrivacyMetadata(field, nested)]));
  }
  return PRIVATE_REQUEST_VALUE;
}

/** Logger-local correlation retains bounded opaque IDs, never values or fingerprints. */
export function createRequestPrivacyProjector(): (value: unknown) => unknown {
  const privateCalls = new Set<string>();
  const privateQuestions = new Set<string>();
  let retainedBytes = 0;
  let exhausted = false;
  const idKey = (id: unknown): string | undefined => {
    if (typeof id !== "string" && !(typeof id === "number" && Number.isFinite(id))) return undefined;
    const key = `${typeof id}:${id}`;
    requestPrivacyStringBytes(key, 1024);
    return key;
  };
  const remember = (set: Set<string>, id: unknown) => {
    const key = idKey(id);
    if (key === undefined || set.has(key)) return;
    const size = requestPrivacyStringBytes(key, 1024);
    if (privateCalls.size + privateQuestions.size >= 8192 || retainedBytes + size > 256 * 1024) {
      throw REQUEST_PRIVACY_LIMIT;
    }
    set.add(key); retainedBytes += size;
  };
  const remembered = (set: Set<string>, id: unknown) => {
    const key = idKey(id);
    return key !== undefined && set.has(key);
  };
  const rpcSecret = (record: Record<string, unknown>, params: Record<string, unknown> | undefined) =>
    (record.method === "tools/call" || record.method === "item/tool/call") && params !== undefined && (
      requestPrivacyTool(params) !== undefined ||
      (typeof record.server === "string" && T3_MCP_SERVER_ALIASES.has(record.server) && params.name === "request_secret")
    );
  const observe = (record: Record<string, unknown>) => {
    const params = requestPrivacyRecord(record.params);
    if (requestPrivacyTool(record) !== undefined || rpcSecret(record, params)) {
      for (const field of REQUEST_ID_FIELDS) {
        remember(privateCalls, record[field]);
        if (params !== undefined) remember(privateCalls, params[field]);
      }
    }
    if (record.isSecret === true) remember(privateQuestions, record.id);
  };
  const project = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(project);
    const record = requestPrivacyRecord(value);
    if (record === undefined) return value;
    const params = requestPrivacyRecord(record.params);
    const tool = requestPrivacyTool(record);
    const rpc = rpcSecret(record, params);
    const correlated = REQUEST_ID_FIELDS.some((field) => remembered(privateCalls, record[field]) ||
      (params !== undefined && remembered(privateCalls, params[field])));
    const sensitive = tool !== undefined || rpc || correlated;
    return Object.fromEntries(Object.entries(record).map(([key, nested]) => {
      if (sensitive && key === "params" && params !== undefined) {
        return [key, Object.fromEntries(Object.entries(params).map(([field, argument]) => [field,
          rpc && field === "arguments" ? projectCapturedSecretRequestInput(argument)
            : requestPrivacyMetadata(field, argument),
        ]))];
      }
      if (tool !== undefined && (key === "input" || key === "arguments")) {
        return [key, projectCapturedSecretRequestInput(nested)];
      }
      if (sensitive) return [key, requestPrivacyMetadata(key, nested)];
      if (record.isSecret === true && PRIVATE_REQUEST_FIELDS.has(key)) return [key, PRIVATE_REQUEST_VALUE];
      if (key === "answers" && requestPrivacyRecord(nested) !== undefined) {
        return [key, Object.fromEntries(Object.entries(nested as Record<string, unknown>).map(([id, answer]) => [
          id, remembered(privateQuestions, id) ? PRIVATE_REQUEST_VALUE : project(answer),
        ]))];
      }
      return [key, project(nested)];
    }));
  };
  return (value) => {
    if (exhausted) return { ...REQUEST_PRIVACY_UNAVAILABLE };
    try { return project(captureRequestPrivacyValue(value, observe)); }
    catch { exhausted = true; return { ...REQUEST_PRIVACY_UNAVAILABLE }; }
  };
}
