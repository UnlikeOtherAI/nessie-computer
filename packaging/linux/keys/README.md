# Linux package publisher

Nessie Executor packages use the UnlikeOtherAI s.r.o. release key:

`C2CDA17E5C87A0F3A22D0A511EEA727FD300D4B9`

The native updater embeds `unlikeotherai-executor.gpg` and verifies a detached
`<package>.asc` signature with `gpgv` before inspecting or installing a DEB/RPM.
The signed catalogue must contain both assets and their exact hashes and sizes.
No user keyring or downloaded key can replace this publisher.

Only public key material belongs here. The encrypted signing key and its
Windows DPAPI-protected passphrase remain in the releasing account's protected
configuration directory on Maxis. RPM repository signatures and package
signatures must use this same key. A rotation needs a release that trusts the
successor before catalogues begin using it.
