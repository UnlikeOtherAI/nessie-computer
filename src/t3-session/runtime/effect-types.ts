import type * as Effect from 'effect/Effect'
import type * as Context from 'effect/Context'

// Preserve the original exported error and service unions in declarations.
export type EffectValue<T> = T extends Effect.Effect<infer A, infer _E, infer _R> ? A : never
export type EffectFailure<T> = T extends Effect.Effect<infer _A, infer E, infer _R> ? E : never
export type EffectServices<T> = T extends Effect.Effect<infer _A, infer _E, infer R> ? R : never
export type ContextServices<T> = T extends Context.Context<infer R> ? R : never
