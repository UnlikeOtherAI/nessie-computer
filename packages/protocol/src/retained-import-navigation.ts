/** Review IDs are navigation hints; the destination re-admits the current recipient. */
export const retainedIssuerReviewPath = (executorId: string, enrollmentId?: string): string => {
  const query = new URLSearchParams({ tab: 'sessions', source: 't3' })
  if (enrollmentId) query.set('retainedEnrollment', enrollmentId)
  return `/admin/computers/${encodeURIComponent(executorId)}?${query}`
}

export const retainedImportGrantPath = (executorId: string, grantId: string): string => {
  const query = new URLSearchParams({ tab: 'sessions', source: 't3', retainedGrant: grantId })
  return `/admin/computers/${encodeURIComponent(executorId)}?${query}`
}
