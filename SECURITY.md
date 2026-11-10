# Security reports and trust boundaries

Report a suspected vulnerability through GitHub's private vulnerability
reporting for this repository. Do not post credentials, local files, pairing
keys or exploit details in a public issue.

The executor is local software with access explicitly granted by the
computer's owner. A server-side team grant does not replace local permissions.
The public protocol package defines the wire contract; it grants no authority
by itself. UOA remains the authority for human identity and team membership.

Program rules, local apps and websites are machine-owned and never travel to
Nessie; only local app names do, in the signed descriptor
([programs, local apps and websites](docs/local-programs.md)). A new team may
start Claude Code, Codex and T3 Code by name, and programs whose code signature
names UnlikeOtherAI. That signature is verified by the operating system:
`codesign` against a Developer ID requirement for team `23B7GTLBN7` on macOS,
Authenticode with UnlikeOtherAI's exact publisher subject on Windows. A file
name, folder or bundle identifier alone never qualifies, unsigned scripts are
not covered, and Linux has no such check. The denylist wins over every
built-in entry and signature. A program admitted by its signature starts from
the exact file that was verified. Discovered local app launch specs stay in
the owner-only state file. A team's saved name (`team-label.json`) is display
metadata only and never grants, narrows or proves access.

Claude Code and Codex offered as engines run the installed program headless
with its own sign-in, its tools, MCP servers and history switched off; Nessie
Computer never reads, copies or refreshes their credentials, and an added
account is the program's own sign-in in a profile folder this app owns
([engines](docs/local-cli-engines.md)). Prompts then go to the provider under
the owner's plan, which Nessie must not present as local processing.

Native custody checks bind processes to an immutable installed release and
verify their creation and lifetime. A version string, a new file beside an old
process, a process group or a successful compiler run does not establish
credential custody. Never weaken these checks to make development builds
eligible for personal credentials.

Personal ChatGPT connections use the public personal-agent OAuth client with
fresh state and PKCE, a loopback callback, and a separate grant per named
profile. Credentials, account selection, refresh and provider requests remain
on the computer. The server receives inference and signed receipts, never
OAuth URLs, codes or tokens. A hosted server is not the OAuth client.

On macOS, credential custody verifies Nessie Computer's signed installation
and actual managed native/runtime processes. Other applications, including
unrelated Node programs and Nessie Desktop's user interface, are not Nessie
Computer credential runtimes. Their presence alone cannot make personal
sign-in unavailable. This is still an owner-account boundary, not an OS
sandbox against other programs the owner runs. Nessie-managed terminal and
coding admissions retain the explicit sign-in fence.

On Windows, custody also refuses any `nessie-computer` or `nessie-executor`
launcher (and the old Desktop app) in a folder on the user or machine PATH, so
a stray npm or hand-made wrapper cannot run the CLI outside the managed
runtime. The one exception is the MSI's own command line:
`nessie-computer.cmd` and `nessie-executor.cmd` in the verified release folder
itself, each a protected file (administrator-owned, no other writers, one
link) holding exactly the bytes of `packaging/windows/nessie-executor.cmd`.
The same names anywhere else, a changed byte, or any other launcher name in
the release folder still fail.

Official Windows packages use UnlikeOtherAI's existing Azure Artifact Signing
publisher. Official macOS packages use Developer ID signing and notarization.
Linux packages and repository metadata are signed. Ordinary public pull request
builds have no production signing credentials or privileged release permissions.

Update installation must authenticate the release, preserve local state and
credential fences, and use the supported native clearance and restart path.
Remote pages and teams cannot select an executable, update origin or install
arbitrary commands through the local control bridge.

On Windows, signed runtime admission has a separate local pipe from pairing and
legacy service controls. Opening it grants no authority: the service proves the
native launcher, immutable release, process generations, account/session and Job
Object. Read-only process/token inspection enables reciprocal verification; no
process-control or impersonation rights are granted.
