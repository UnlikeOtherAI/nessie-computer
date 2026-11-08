# Local AI connections

The shared Windows/macOS executor console owns AI connections in an AI tab between Sync and Settings. A team row opens that same tab for its team. It contains multiple named ChatGPT sign-ins and multiple named local or LAN model-server endpoints. Remote inference servers do not need an executor: the paired computer owns the connection and routes inference to them.

## Acceptance

- Team names come from the paired service backed by UOA. Name failures remain recoverable and never grant authority.
- UI labels are not selectable; inputs and explicitly copyable codes remain selectable.
- Each ChatGPT connection has a stable profile identity, an owner-chosen local label, independent login/disconnect and background consent. Adding an account cannot resume or overwrite another profile. Native credential custody and per-account funding remain enforced.
- Endpoint addresses and optional credentials are supplied only by the local owner. Save multiple endpoints, observe availability/models, edit or remove one independently, and preserve existing configuration.
- LAN model requests run from this computer. Endpoint identity scopes model names and digests, so identical model IDs cannot cross-route. A removed or changed endpoint fences old model consent. No automatic fallback to another endpoint.
- Persist no additional server-side UOA identity or membership data. Keep credentials out of renderer responses, logs and arguments.
- Translate visible copy, exercise successful and refused operations through native controls and headless shared-console journeys, capture matching before/after UI evidence, and verify the signed installed flow.

## Delivery status

Implementation in progress. Existing native trust failures and the live personal-plan task remain open; no installed acceptance is claimed.
