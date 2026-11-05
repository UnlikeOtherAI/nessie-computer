import { z } from 'zod'

import { createUuidBrandSchema } from './schema-primitives.js'

export const OrganizationIdSchema = createUuidBrandSchema<'OrganizationId'>()
export type OrganizationId = z.infer<typeof OrganizationIdSchema>
export const UserIdSchema = createUuidBrandSchema<'UserId'>()
export type UserId = z.infer<typeof UserIdSchema>
export const ProjectIdSchema = createUuidBrandSchema<'ProjectId'>()
export type ProjectId = z.infer<typeof ProjectIdSchema>
export const TeamIdSchema = createUuidBrandSchema<'TeamId'>()
export type TeamId = z.infer<typeof TeamIdSchema>
export const ChannelIdSchema = createUuidBrandSchema<'ChannelId'>()
export type ChannelId = z.infer<typeof ChannelIdSchema>
export const AgentIdSchema = createUuidBrandSchema<'AgentId'>()
export type AgentId = z.infer<typeof AgentIdSchema>
export const ThreadIdSchema = createUuidBrandSchema<'ThreadId'>()
export type ThreadId = z.infer<typeof ThreadIdSchema>
export const RunIdSchema = createUuidBrandSchema<'RunId'>()
export type RunId = z.infer<typeof RunIdSchema>
export const TaskIdSchema = createUuidBrandSchema<'TaskId'>()
export type TaskId = z.infer<typeof TaskIdSchema>
export const BoardIdSchema = createUuidBrandSchema<'BoardId'>()
export type BoardId = z.infer<typeof BoardIdSchema>
export const BoardColumnIdSchema = createUuidBrandSchema<'BoardColumnId'>()
export type BoardColumnId = z.infer<typeof BoardColumnIdSchema>
export const ResourceShareIdSchema = createUuidBrandSchema<'ResourceShareId'>()
export type ResourceShareId = z.infer<typeof ResourceShareIdSchema>
export const TaskFieldDefinitionIdSchema =
  createUuidBrandSchema<'TaskFieldDefinitionId'>()
export type TaskFieldDefinitionId = z.infer<typeof TaskFieldDefinitionIdSchema>
export const IterationIdSchema = createUuidBrandSchema<'IterationId'>()
export type IterationId = z.infer<typeof IterationIdSchema>
export const KnowledgePageIdSchema = createUuidBrandSchema<'KnowledgePageId'>()
export type KnowledgePageId = z.infer<typeof KnowledgePageIdSchema>
export const ThoughtIdSchema = createUuidBrandSchema<'ThoughtId'>()
export type ThoughtId = z.infer<typeof ThoughtIdSchema>
export const ThoughtRecallIdSchema = createUuidBrandSchema<'ThoughtRecallId'>()
export type ThoughtRecallId = z.infer<typeof ThoughtRecallIdSchema>

// ─── Phase 2 Branded IDs ────────────────────────────────────────────────────
export const ApprovalIdSchema = createUuidBrandSchema<'ApprovalId'>()
export type ApprovalId = z.infer<typeof ApprovalIdSchema>
export const AuditLogIdSchema = createUuidBrandSchema<'AuditLogId'>()
export type AuditLogId = z.infer<typeof AuditLogIdSchema>
export const PolicyIdSchema = createUuidBrandSchema<'PolicyId'>()
export type PolicyId = z.infer<typeof PolicyIdSchema>
export const PolicyBindingIdSchema = createUuidBrandSchema<'PolicyBindingId'>()
export type PolicyBindingId = z.infer<typeof PolicyBindingIdSchema>
export const TokenLedgerEventIdSchema = createUuidBrandSchema<'TokenLedgerEventId'>()
export type TokenLedgerEventId = z.infer<typeof TokenLedgerEventIdSchema>
export const InferenceProviderIdSchema = createUuidBrandSchema<'InferenceProviderId'>()
export type InferenceProviderId = z.infer<typeof InferenceProviderIdSchema>
export const InferenceCredentialBindingIdSchema =
  createUuidBrandSchema<'InferenceCredentialBindingId'>()
export type InferenceCredentialBindingId = z.infer<
  typeof InferenceCredentialBindingIdSchema
>
export const InferenceModelIdSchema = createUuidBrandSchema<'InferenceModelId'>()
export type InferenceModelId = z.infer<typeof InferenceModelIdSchema>
export const InferenceRoutingProfileIdSchema =
  createUuidBrandSchema<'InferenceRoutingProfileId'>()
export type InferenceRoutingProfileId = z.infer<
  typeof InferenceRoutingProfileIdSchema
>

export const parseOrganizationId = (value: string): OrganizationId =>
  OrganizationIdSchema.parse(value)
export const parseUserId = (value: string): UserId => UserIdSchema.parse(value)
export const parseProjectId = (value: string): ProjectId => ProjectIdSchema.parse(value)
export const parseTeamId = (value: string): TeamId => TeamIdSchema.parse(value)
export const parseChannelId = (value: string): ChannelId => ChannelIdSchema.parse(value)
export const parseAgentId = (value: string): AgentId => AgentIdSchema.parse(value)
export const parseThreadId = (value: string): ThreadId => ThreadIdSchema.parse(value)
export const parseRunId = (value: string): RunId => RunIdSchema.parse(value)
export const parseTaskId = (value: string): TaskId => TaskIdSchema.parse(value)
export const parseBoardId = (value: string): BoardId => BoardIdSchema.parse(value)
export const parseBoardColumnId = (value: string): BoardColumnId =>
  BoardColumnIdSchema.parse(value)
export const parseResourceShareId = (value: string): ResourceShareId =>
  ResourceShareIdSchema.parse(value)
export const parseTaskFieldDefinitionId = (value: string): TaskFieldDefinitionId =>
  TaskFieldDefinitionIdSchema.parse(value)
export const parseIterationId = (value: string): IterationId =>
  IterationIdSchema.parse(value)
export const parseKnowledgePageId = (value: string): KnowledgePageId =>
  KnowledgePageIdSchema.parse(value)
export const parseThoughtId = (value: string): ThoughtId => ThoughtIdSchema.parse(value)
export const parseThoughtRecallId = (value: string): ThoughtRecallId =>
  ThoughtRecallIdSchema.parse(value)
export const parseApprovalId = (value: string): ApprovalId =>
  ApprovalIdSchema.parse(value)
export const parseAuditLogId = (value: string): AuditLogId =>
  AuditLogIdSchema.parse(value)
export const parsePolicyId = (value: string): PolicyId => PolicyIdSchema.parse(value)
export const parsePolicyBindingId = (value: string): PolicyBindingId =>
  PolicyBindingIdSchema.parse(value)
export const parseTokenLedgerEventId = (value: string): TokenLedgerEventId =>
  TokenLedgerEventIdSchema.parse(value)
export const parseInferenceProviderId = (value: string): InferenceProviderId =>
  InferenceProviderIdSchema.parse(value)
export const parseInferenceCredentialBindingId = (
  value: string,
): InferenceCredentialBindingId => InferenceCredentialBindingIdSchema.parse(value)
export const parseInferenceModelId = (value: string): InferenceModelId =>
  InferenceModelIdSchema.parse(value)
export const parseInferenceRoutingProfileId = (
  value: string,
): InferenceRoutingProfileId => InferenceRoutingProfileIdSchema.parse(value)
