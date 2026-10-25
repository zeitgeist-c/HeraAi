# Public cloud and personal model catalog

Status: 1.12.0 local implementation; gateway and gateway-only rules are NOT deployed. Existing `DURUM.md` is unrelated WIP and preserved.

## Milestones

1. Discover Gemini/OpenRouter/Ollama models using each user's own stored keys. Cache metadata and key IDs only. Enable models explicitly, keep provider+model identity, constrain fallback to enabled models. Test discovery, pagination, key isolation, settings and chat selection.
2. Route every cloud data operation through an authenticated Cloud Functions gateway. Default deny direct Firestore access in the separate public deployment configuration. Atomically enforce daily per-account requests, operations, transfer, sync runs, total storage and device count. Owner role comes from a server-side UID document and bypasses product quotas, including the general-user pool. Technical request limits still apply.
3. Run regression suite, lint, build, gateway integration and authorization checks. Commit only scoped files. A source build is not evidence of deployed quota enforcement.

## Proposed initial policy

Daily: 60 sync starts, 1,000 gateway requests, 5,000 metered reads, 2,000 metered writes, 10 MiB transferred per normal account. Operation allowances include the gateway's counter overhead so 60 small syncs are not inherently prevented by their own bookkeeping. Total: 10 MiB serialized data (including pending encrypted chunks) and 3 active devices. General-user pool: 35,000 metered reads and 12,000 metered writes/day. Quota bookkeeping and retries also cost operations: these application counters are conservative admission controls, not exact billing meters or a monetary hard cap. Public traffic still shares Firebase infrastructure with the owner. Abuse at the network/authentication layer can incur charges even when a data request is denied; monitoring and a public-service stop switch are required before opening access.

Daily reset uses UTC on the server and is displayed as a timestamp, never trusts client time. Owner email is supplied operationally, not embedded in extension/source. Owner provisioning resolves a verified Google-authenticated Firebase account to UID using Admin credentials.

## Deployment gate

Cloud Functions production deployment needs Blaze and explicit deployment authorization. Existing direct-access clients must update before gateway-only Firestore rules are deployed. Use an isolated emulator first. Existing users require a server-side storage inventory before normal-user quotas can be enabled. Public packaging must use the gateway endpoint. Until gateway and rules are deployed together, the existing project is not protected by these new quotas.

## Model semantics

Catalog visibility is not a successful generation test and never implies free access. Newly discovered models are disabled until selected. Failed refresh preserves the last catalog for that provider; removed keys must not be used. Unknown modalities are conservative. Gemini/Ollama price metadata is not guessed. Tavily remains a search integration. Shared cloud stores encrypted data; API keys are never sent to the quota gateway in plaintext.

## Verified on 2026-10-25

- Existing live project is `heraai-sync`, Firestore Standard Native in `eur3`. Billing is disabled. No billing account, functions or security rules were changed.
- The requested owner was resolved to a verified Google Firebase account and the `cloudRoles/{uid}` owner record was written and read back. No email/token/credential is embedded in source or extension. This record is used only by the new gateway; legacy clients do not use it.
- Extension: 52 test files, 1,042 tests passed with `npm run test:run -- --maxWorkers=2`. Four existing timing-sensitive App tests failed once during concurrent build/full-suite load, passed individually, and then passed in the complete isolated run. Tests were not relaxed.
- Gateway policy: 8 Node tests passed. Actual Firestore emulator: 5 integration tests passed (concurrent quota, setup/entity/cursor, chunk paging/protected live revision, direct data/role access denied by rules, owner exemption while public service paused).
- Live provider model listings and production callable gateway are not validated by these tests. Emulator tests do not establish real billing protection.

## Controlled production activation

1. Obtain explicit approval for Blaze and external deployment. Upgrade billing in Firebase Console; do not infer permission to attach a payment account from local implementation authorization.
2. `functions/node_modules/.bin/firebase.cmd deploy --project heraai-sync --config firebase.gateway.json --only functions` deploys the gateway without changing legacy rules. Keep public service disabled initially (missing `cloudConfig/public.enabled` means disabled).
3. Build with `VITE_CLOUD_GATEWAY_URL=https://europe-west1-heraai-sync.cloudfunctions.net/cloudGateway`. Install the owner's candidate build and verify real encrypted sync and owner status before replacing others' clients. No fallback to direct Firestore occurs if a configured gateway fails.
4. Arrange a short migration window: stop sync on all existing devices, including owner devices. Retain encrypted/local backups. Deploy gateway-only rules using the separate config, then inventory existing data while writers remain stopped. Never inventory concurrent with legacy writes.
5. Run operator provisioning with explicit `GCLOUD_PROJECT` and credentials: `node functions/provision.js inventory`, then `node functions/provision.js enable-public`. `HERAAI_USE_FIREBASE_CLI_AUTH=1` permits using the already authenticated local CLI without creating a credential file. Owner setup uses `HERAAI_OWNER_EMAIL` operationally and verifies the Google account before writing the role. Do not print `firebase login:list --json`; its output includes tokens.
6. Verify real owner and normal-account sync, denial of direct Firestore access, and a quota-exceeded response before making the store listing public. `node functions/provision.js pause-public` pauses general users while the owner remains admitted. It does not disable infrastructure billing.

`scripts/package-store.ps1` refuses a legacy/private cloud build by default. An explicitly unlisted/private build can be produced with `-AllowPrivateCloud`; store artifacts use `release/store/HeraAi-1.12.0.zip`. Standard local artifacts use `release/HeraAi-1.12.0.zip`. Neither source tags nor packaging are store publication.

## Security and operating limits

Every gateway request is independently subject to server-authenticated operation, transfer and storage admission limits; resource quotas do not depend on the client calling the sync-start endpoint. The 60-sync start counter controls the normal application's runs and must not be treated as a standalone abuse defense. Rejected traffic, retries, index reads and platform overhead can incur costs outside application counters. Global public counters are intentionally a single transaction bottleneck for a small rollout; revisit sharding before large concurrency. Firebase Auth abuse controls and monitoring still apply. Extension-compatible App Check attestation is not configured; do not enable enforcement blindly and lock out installed clients.

Storage quotas measure serialized payload bytes, excluding server timestamps, rather than exact billed Firestore storage/index bytes. Encrypted pending chunk revisions also count toward capacity. Legacy bulk-cleanup requests are explicitly refused by the public gateway; bounded operator cleanup must be designed separately if required. Existing legacy private cleanup is unchanged. Shared Firebase infrastructure and vendor limits still affect the owner, even though product quotas do not.
