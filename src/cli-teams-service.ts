import type { ServiceTeam } from './cli-teams.js'
import { serviceRequests, serviceTeamList, ServiceUnreachable, type ServiceCall } from './windows-service-control.js'

/**
 * The Windows background service's teams, listed the way the Windows app
 * lists them. A service that is not installed, or that has never admitted
 * this Windows account, simply has no teams for it; one that cannot be
 * reached says so on the Overview commands. Each row carries the label the
 * service read from the team's folder (`team-label.ts`), so naming a service
 * team asks nothing more of it.
 */

export type ServiceTeams = { teams: ServiceTeam[]; note?: string }

const SILENT = new Set(['notInstalled', 'notAdmitted'])

export const findServiceTeams = async (call: ServiceCall): Promise<ServiceTeams> => {
  try {
    const teams = serviceTeamList(await call(serviceRequests.status()))
    return { teams: teams.map((service) => ({ route: 'service', executorId: service.executorId, service })) }
  } catch (error) {
    if (error instanceof ServiceUnreachable && SILENT.has(error.reason)) return { teams: [] }
    return { teams: [], note: `${error instanceof Error ? error.message : String(error)} Teams it runs aren't listed.` }
  }
}
