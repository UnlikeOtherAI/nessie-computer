/**
 * What an OpenAI-compatible model server says about its own models. Every
 * value here is the server's report, never an owner's declaration and never a
 * model-name heuristic; a server that does not report a value leaves it unknown.
 *
 * The listing (`/v1/models`) is common to all of them. llama.cpp and the
 * servers built on it (Strata among them) also describe the loaded model at
 * `/props`: the context each slot serves, whether its chat template renders
 * tools, whether it can see images, and the template itself.
 */

/** `ObservedLocalModelSchema` refuses a local model reporting more than this. */
const LOCAL_CONTEXT_BOUND = 1_000_000
const LOCAL_OUTPUT_BOUND = 100_000

export type ServerProps = {
  /** The model these props describe, when the server names it. */
  alias: string | null
  context: number | null
  maxOutputTokens: number | null
  thinking: boolean
  tools: boolean
  vision: boolean
  /** The loaded weights, hashed into the model's identity so a swap behind one name is a new model. */
  weights: string | null
}

export type ReportedModel = {
  id: string
  numCtxCap: number | null
  maxOutputTokens: number | null
  thinking: boolean
  tools: boolean
  vision: boolean
  weights: string | null
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const positive = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : null

export const serverPropsFrom = (body: unknown): ServerProps => {
  const props = record(body)
  const settings = record(props?.default_generation_settings)
  const caps = record(props?.chat_template_caps)
  const nPredict = positive(record(settings?.params)?.n_predict)
  const template = typeof props?.chat_template === 'string' ? props.chat_template : ''
  return {
    alias: text(props?.model_alias, 200),
    context: positive(settings?.n_ctx),
    maxOutputTokens: nPredict,
    // The template takes the switch the chat transport sends to turn thinking off on a silent turn.
    thinking: /\benable_thinking\b/u.test(template),
    tools: caps?.supports_tools === true,
    vision: record(props?.modalities)?.vision === true,
    weights: text(props?.model_path, 4096),
  }
}

/**
 * One listing entry, completed by `/props` when they describe the same model.
 * The served context wins, bounded by the context the model was trained for;
 * neither reported leaves it unknown, and Nessie asks the owner.
 */
export const reportedModelFrom = (entry: Record<string, unknown>, id: string,
  props: ServerProps | null): ReportedModel | null => {
  const architecture = record(entry.architecture)
  const output = strings(architecture?.output_modalities)
  if (Array.isArray(architecture?.output_modalities) && !output.includes('text')) return null
  const meta = record(entry.meta)
  const served = positive(meta?.n_ctx) ?? positive(entry.max_model_len) ?? positive(entry.context_length)
    ?? props?.context ?? null
  const trained = positive(meta?.n_ctx_train)
  const numCtxCap = served === null ? null : Math.min(served, trained ?? served, LOCAL_CONTEXT_BOUND)
  const outputLimit = props?.maxOutputTokens ?? null
  const maxOutputTokens = outputLimit !== null && outputLimit <= LOCAL_OUTPUT_BOUND
    && (numCtxCap === null || outputLimit < numCtxCap) ? outputLimit : null
  const parameters = strings(entry.supported_parameters)
  return {
    id, numCtxCap, maxOutputTokens,
    thinking: props?.thinking === true,
    tools: parameters.includes('tools') || props?.tools === true,
    vision: strings(architecture?.input_modalities).includes('image') || props?.vision === true,
    weights: props?.weights ?? null,
  }
}
