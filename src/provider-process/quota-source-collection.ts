import type { QuotaAccounts } from './quota-values.js'

/** A failed provider cannot hide another provider's valid readings or expose its diagnostic body. */
export const collectQuotaSources = async (sources: readonly Promise<QuotaAccounts>[]): Promise<QuotaAccounts> => {
  const results = await Promise.allSettled(sources)
  return {
    accounts: results.flatMap(result => result.status === 'fulfilled' ? result.value.accounts : []),
    incomplete: results.some(result => result.status === 'rejected' || result.value.incomplete),
  }
}
