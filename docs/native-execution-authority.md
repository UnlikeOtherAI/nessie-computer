# Protected execution issuer

This protocol is under implementation and remains unqualified. The initial
schema checkpoint alone supplies no issuer, enrollment or launch authority.

`packages/protocol/src/t3-session/native-execution.ts` defines the distinct
execution domains and strict schemas. Signatures cover UTF8(domain + newline +
exact payload string). Backend admissions use RS256 and the protected paired
origin's JWKS; native receipts use a separate service-owned Ed25519 key, SPKI
base64 public key and SHA256 SPKI key ID. Receipt signatures are base64url.
Keys carried in receipts never establish trust.

The descriptor includes independently observed service/controller/supervisor/
runtime generations, installed release digest, service image digest and Job.
Its self-signature proves possession only. Enrollment stays pending until the
exact descriptor/challenge has both protected local owner approval and the
backend's explicit canonical UOA owner verification. The challenge binds the
enrollment/executor IDs, paired origin, descriptor digest, nonce and deadline.
No retained-import key or signing domain is reused.

Reservation has no native ID or provider-session ID. Its binding contains opaque
SHA256 actor/initiation references, both original request SHA256 and relay HMAC,
and a sourceEvidenceDigest. That evidence must come from an actual held source
graph admission before reservation; the reserve DTO cannot create it. Original
references stay in the backend relay. Launch adds its exact launch digest;
association adds the original provider-session ID and service-observed native
identity. An observed native ID never substitutes for an original session ID.

The source graph producer and original SDK serializer remain separate owned
dependencies. Generic SDK stdin remains denied. No signing, install, native
launch or heavy check is authorized in this checkout's source window.
