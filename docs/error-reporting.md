# Error reporting

Nessie Computer uses the standard Sentry Node SDK for CLI and daemon errors,
the Sentry Rust SDK for Windows tray/service panics, and Sentry Apple for the
macOS menu bar app. The CLI has no product analytics.

Official release jobs supply NESSIE_COMPUTER_SENTRY_DSN from GitHub Secrets.
The Node runtime embeds that ingestion identifier during packaging; native
Windows builds use it at compilation, and the macOS bundle expands it into
NessieSentryDSN. Source runs may supply the same environment variable.
SENTRY_RELEASE identifies source runs; packaged Node reports use their exact
Computer version and source commit.

The SDKs retain their standard processing and breadcrumbs. No Nessie profile,
email, team identity or personal AI credential is deliberately attached.
Privileged Sentry access/upload tokens must never be embedded in an app or
committed. A DSN is a public ingestion identifier and is extractable from a
distributed binary even when injected through Secrets.

Uncaught exceptions, rejected promises, console errors and terminal CLI failures
are reported. Commands keep their exit behavior and flush pending reports for up
to two seconds. Rust panics and terminal Windows service startup failures are
reported. macOS enables Sentry's recommended uncaught NSException reporting.

SIGKILL, forced Windows termination, power loss and some OOM exits cannot run a
reporter. The Rust SDK does not install Crashpad for access violations or
segmentation faults. Installed native crash delivery and readable symbols must
be proved on the actual OS without a debugger before calling a release verified.

For source verification, run the focused public Turbo reporting gate and use the
real CLI's success and failure paths against a local collector. A collector
accepting a test envelope is not evidence that the production Sentry project,
release credentials, installed crash delivery or symbol uploads are configured.
