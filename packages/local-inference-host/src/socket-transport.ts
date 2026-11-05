/**
 * Constants and the signing shape of the host's one socket to Nessie
 * (`docs/standards/local-ollama-agents.md`, "Execution and storage").
 */
export const LOCAL_INFERENCE_SOCKET_PATH = '/api/local-inference/daemon/socket'

/**
 * Deltas within this window travel as one frame. A frame is relayed to the
 * worker without a database write, but each is still a signed socket message,
 * so a frame per token would make the relay, not the model, the pace.
 */
export const LOCAL_INFERENCE_FRAME_COALESCE_MS = 150
/** A burst flushes at this many bytes of raw UTF-8 text before the window ends. */
export const LOCAL_INFERENCE_FRAME_COALESCE_BYTES = 4 * 1024

/**
 * Every socket message after the `connect` handshake is signed over its body
 * and the connection id the server issued, so it cannot be replayed on another
 * connection of the same epoch: replay within a connection is refused by the
 * sequence the server holds for that connection in memory.
 */
export const localInferenceSocketSignedBody = (connectionId: string, body: unknown): {
  body: unknown; connectionId: string
} => ({ body, connectionId })
