import * as Sentry from '@sentry/node'

const dsn = process.env.NESSIE_COMPUTER_SENTRY_DSN
if (dsn) {
  Sentry.init({
    dsn,
    release: process.env.SENTRY_RELEASE,
    initialScope: { tags: { component: 'computer' } },
    integrations: [Sentry.captureConsoleIntegration({ levels: ['error'] })],
  })
}

export const reportError = Sentry.captureException
export const flushErrors = (): Promise<boolean> => Sentry.flush(2000)
