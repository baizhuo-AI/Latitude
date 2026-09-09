# Latitude local domain service

`latitude-domain` is the standalone browser-P0 domain boundary. It binds only to
`127.0.0.1:43121`, owns its SQLite schema/migrations, and does not read model credentials.

## Run

```bash
cargo run --manifest-path src-tauri/domain-service/Cargo.toml --bin latitude-domain
```

Optional server-only environment variables:

- `LATITUDE_DB_PATH` (default `.latitude/latitude-domain.db`)
- `LATITUDE_BACKUP_DIR` (default `.latitude/backups`)
- `LATITUDE_DOMAIN_ADDR` (default `127.0.0.1:43121`; non-loopback addresses are rejected)
- `LATITUDE_WEB_PORT` (default `1420`; CORS admits only `127.0.0.1` / `localhost` on this exact Browser port)

On every non-empty database startup, the service makes a timestamped backup before running
transactional migrations. SQLite runs with foreign keys, WAL, a busy timeout, and integrity
checks around restore. On Unix, the database parent and backup directory are forced to `0700`,
database/backup/WAL/SHM files to `0600`; database and sidecar symlinks are rejected rather than
followed or copied.

## Stable HTTP contract

All bodies are JSON/camelCase. Mutating endpoints accept `Idempotency-Key`; the ledger and
the domain mutation commit in the same SQLite transaction. Reusing a key with the same body
returns the first response, while a changed body returns `409`.

Normal routes have a strict 2 MiB request limit. Only
`POST /v1/admin/dangerous/prepare` has a dedicated 64 MiB limit so a complete restore snapshot
can pass without expanding any ordinary write surface. Computer History segment import has a
route-local 16 MiB limit because an accessibility-tree event can contain a large visible document.
Export checksums use the exact shape
`sha256:<64 lowercase hexadecimal characters>`.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | Readiness, schema version, node/revision counts |
| `POST` | `/v1/context` | Query active graph context; hard SQL filters by optional `sensitivityCeiling`, exact `kinds`, and `evidenceTypes` (the latter constrains only `evidence_event`) |
| `GET` | `/v1/changes?limit=100` | Latest-first ChangeSets with before/after/inverse operations |
| `POST` | `/v1/changes` | Flat `operation=remember/update/retract/rollback` mutation |
| `POST` | `/v1/changes/{changeSetId}/rollback` | Compatibility rollback route |
| `POST` | `/v1/actions` | Create timed action; requires `expectedOutcome`, `trigger`, `observationWindow`, `reviewAt` |
| `GET` | `/v1/actions/due?at={RFC3339}&sensitivityCeiling=low` | Open unconcluded actions whose related EvidenceEvent arrived or whose `reviewAt` fallback elapsed; returns `dueReason` and a durable event receipt, filtered before `limit` |
| `POST` | `/v1/candidates` | Create an evidence-linked co-creation candidate in `proposed`; silence never authorizes transition |
| `POST` | `/v1/candidates/{candidateId}/commands` | Typed `touch / shape / conclude / park`; `acknowledge_due` is reserved for Host delivery receipts |
| `GET` | `/v1/candidates/due?at={RFC3339}&sensitivityCeiling=low` | Read-only 3-day proposed / 7-day shaping reminders; delivered reminders are durably suppressed without changing state |
| `POST` | `/v1/outcomes` | Evidence-backed `confirms/contracts/revises/refutes/unknown`; unknown enters revision queue |
| `GET` | `/v1/revisions?status=pending&limit=100&sensitivityCeiling=low` | Read claim-revision receipts filtered before `limit` |
| `POST` | `/v1/revisions/{revisionId}/resolve` | Apply `confirms/contracts/revises/refutes` or `dismissed` to a pending receipt |
| `GET` | `/v1/reviews?status=due&dueBefore={RFC3339}&sensitivityCeiling=low` | Return latest complete week only when it has an eligible loop artifact; stable ceiling-specific `receiptKey` |
| `POST` | `/v1/reviews` | Generate/deduplicate a hard-filtered structured single/double-loop review |
| `POST` | `/v1/evidence/query` | Search full raw evidence independently of the graph, reverse-resolve `nodeIds`, and continue with `offset` / `coverage.nextOffset`; no sensitivity filtering |
| `POST` | `/v1/evidence/read` | Read full text by `evidenceRefId`, or continue by Unicode `offset` / `length`; `range.nextOffset` marks the next part |
| `POST` | `/v1/evidence/computer-history` | Idempotently import one Skysight segment as a source plus raw EvidenceRefs, without inferring semantic nodes |
| `POST` | `/v1/evidence/message` | Atomically capture a user-authored chat source, EvidenceRef, and evidence event |
| `POST` | `/v1/evidence/web` | Store web provenance plus required immutable ranking-time `whyNow` as untrusted evidence, never prompt authority |
| `POST` | `/v1/star-map/locate-event` | Read-only graph-aware location projection; `mutationPerformed=false` |
| `POST` | `/v1/star-map/apply-location` | Audited `orbits` + semantic edge + StarState mutation; semantic-only stays proposed |
| `POST` | `/v1/relationships` | Create one evidence-backed, auditable relationship between current nodes without fabricating an `orbits` edge |
| `POST` | `/v1/star-map/compile-context` | Bounded graph traversal with paths, StarStates, epistemic and sensitivity policy |
| `POST` | `/v1/star-map/apply-feedback` | Version claim feedback or persist resource curator preference without changing source trust |
| `GET` | `/v1/admin/integrity` | `quick_check`, foreign-key violations, and core counts |
| `GET` | `/v1/admin/export` | Deterministic full JSON export with content checksum |
| `POST` | `/v1/admin/dangerous/prepare` | Stage `restore`, recoverable `delete_all`, or irreversible `purge_all` |
| `POST` | `/v1/admin/dangerous/commit` | Commit staged operation with token + exact phrase |

Successful graph writes return `{ok, changeSetId, value}`. Ordinary message/memory/action input
defaults to `sensitivity=medium`. The local Agent's interactive and scheduled reads use the
owner-authorized full scope (`highest`), rather than a hidden `low`-only gate. Explicitly
requested narrower ceilings are still valid query filters; the low-ceiling API examples below
illustrate those filters, not the scheduler's default authorization.
A model write stays `origin=model, authority=system_inferred`, even if it cites a verified user
message: that EvidenceRef proves what the user said, not that a model paraphrase is equivalent.
Only an HTTP write with `audit.actor=user` can create `user_stated`, `user_corrected`, or an
explicit `user_confirmed` fact. Relationship authority also depends on basis plus verified
user-authored EvidenceRefs: contextual, behavioral, metric, or semantic-only relationship
inferences remain `system_inferred/proposed` even when the user triggered the request. Model claim
inference without EvidenceRefs is stored as an
unsupported/proposed observation, never a canonical active claim. Generic claim update is
fail-closed; claim semantics must use feedback, outcomes, or retract so lineage is preserved.

For the event clock, the action itself must pass the requested sensitivity ceiling. A standard
`medium` Browser chat event may wake an already-`low` action only through an explicit durable
relation and only as opaque control-plane metadata; the due projection and scheduler prompt never
include its statement, excerpt, or source content. `high` / `highest` events remain invisible until
the caller explicitly raises the ceiling. Unrelated events never wake an action.

`POST /v1/outcomes` accepts `evidenceRefs`. A model actor must provide at least one valid active
ref and remains model/system-inferred. A direct browser user may pass an empty array: the Domain
transaction creates a `checkin` source, verified user EvidenceRef, evidence-event node, outcome,
result/effect edges and ChangeSet atomically. Rollback retracts that evidence and removes a queued
revision, so no ghost receipt remains.

Web evidence transactionally creates a `source_records(web_search)`, `evidence_refs`,
`resource` node, provenance link, and ChangeSet. Its node is `imported_unverified`, and its
payload explicitly carries `untrustedContent=true` and `promptAuthority=none`. URLs must be
absolute HTTP(S), have a host, and contain no username/password. `whyNow` is required, non-blank,
and limited to 500 Unicode characters; Domain preserves the exact Host ranking-time string in
source metadata and the Resource payload, but it conveys no prompt, tool, or write authority.
Resource feedback creates an
`interest` node with `payload.preferenceType=curator_preference`, a positive/negative/
already_known signal and provenance edges; it never upgrades or rewrites the Resource authority.

Weekly review `value.sections` has
`singleLoop{dueActions,outcomes,actionsWithoutEvidence,question}` and
`doubleLoop{changedClaims,contradictions,pendingRevisions,reframePrompts,question}`. The review
node has bounded `provenance/derived_from` trace edges to included actions, outcomes, and changed
claims and inherits a capped set of their EvidenceRefs, so compile-context can walk back to facts.
Automatic `status=due` is suppressed on an empty completed week: `items=[]` and
`latestCompleteWeek.status=empty`. An open due action, an outcome in the period, a pending claim
revision, or a changed claim inside the requested sensitivity ceiling makes it eligible. Manual
`POST /v1/reviews` remains available even for an explicitly requested empty period.

The hidden safety workflow is deliberately two-stage and has two distinct deletion meanings:

- restore: prepare with `{operation:"restore", snapshot:<export>}`, then commit with
  `RESTORE LOCAL DATA`;
- recoverable reset (compatibility operation name `delete_all`): prepare with
  `{operation:"delete_all"}`, then commit with `DELETE ALL LOCAL DATA`; this creates a local
  pre-reset backup;
- permanent purge: prepare with `{operation:"purge_all"}`, then commit within two minutes with
  `PERMANENTLY DELETE ALL LATITUDE DATA`. It creates no backup or persistent audit receipt,
  clears domain/audit/idempotency rows, checkpoints and removes WAL/SHM, runs `VACUUM`, and
  deletes only strictly recognized Latitude backup artifacts.

Restore and recoverable reset create pre-operation backups. Recoverable reset retains only a
reset receipt and its non-reversible ChangeSet. Permanent purge does neither. Its backup cleanup
never follows symlinks or recursively deletes the configured directory: unknown entries,
directories, symlinks, and cleanup errors are preserved and reported as `status=partial`.
Exports or copies outside `LATITUDE_BACKUP_DIR` are outside the service's deletion authority.
Restore validates format/checksum, restores in one transaction, runs SQLite integrity checks,
re-exports the restored content, and verifies the checksum before commit.

Ordinary startup backups are a separate bounded safety layer. The service retains the newest ten
`startup.bak` groups (including their WAL/SHM sidecars) and prunes older recognized regular files
before copying the next group. It never prunes `pre-restore`, `pre-delete-all`, other recovery
reasons, unknown files, directories, or symlinks; an unsafe forged startup artifact fails closed.

## Browser acceptance curl sequence

The following sequence uses only local dummy data and no credentials.

```bash
base=http://127.0.0.1:43121

curl -s "$base/health" | jq

message=$(curl -s -X POST "$base/v1/evidence/message" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: accept-message-1' \
  -d '{"clientRequestId":"accept-message-1","messageId":"accept-chat-1","content":"我发现上午更容易稳定产出。","sensitivity":"low","audit":{"actor":"user","sessionId":"acceptance","turnId":"1","authorizationMode":"automatic"}}')
claim_ref=$(printf '%s' "$message" | jq -r '.value.evidenceRefId')
printf '%s' "$message" | jq

claim=$(curl -s -X POST "$base/v1/changes" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: accept-remember-1' \
  -d "{\"operation\":\"remember\",\"clientRequestId\":\"accept-remember-1\",\"label\":\"上午适合深度工作\",\"statement\":\"上午更容易稳定产出\",\"kind\":\"claim\",\"payload\":{},\"scope\":{\"domain\":\"work\"},\"sensitivity\":\"low\",\"evidenceRefs\":[\"$claim_ref\"],\"audit\":{\"actor\":\"model\",\"sessionId\":\"acceptance\",\"turnId\":\"1\",\"toolCallId\":\"remember\",\"authorizationMode\":\"automatic\"}}")
claim_id=$(printf '%s' "$claim" | jq -r '.value.id')
printf '%s' "$claim" | jq

event=$(curl -s -X POST "$base/v1/evidence/message" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: accept-message-2' \
  -d '{"clientRequestId":"accept-message-2","messageId":"accept-chat-2","content":"今天上午完成了一次深度工作。","sensitivity":"low","audit":{"actor":"user","sessionId":"acceptance","turnId":"2","authorizationMode":"automatic"}}')
event_id=$(printf '%s' "$event" | jq -r '.value.nodeId')
event_ref=$(printf '%s' "$event" | jq -r '.value.evidenceRefId')

curl -s -X POST "$base/v1/star-map/locate-event" -H 'Content-Type: application/json' \
  -d "{\"eventNodeId\":\"$event_id\",\"evidenceRefs\":[\"$event_ref\"],\"projectContext\":{\"domain\":\"work\"},\"queryPolicy\":{\"maxCandidates\":8,\"allowSemanticOnly\":true},\"sensitivityCeiling\":\"low\",\"audit\":{\"actor\":\"model\",\"authorizationMode\":\"automatic\"}}" | jq

location=$(curl -s -X POST "$base/v1/star-map/apply-location" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: accept-location-1' \
  -d "{\"clientRequestId\":\"accept-location-1\",\"eventNodeId\":\"$event_id\",\"starCenterNodeId\":\"$claim_id\",\"relationType\":\"part_of\",\"evidenceRefs\":[\"$event_ref\"],\"basis\":\"deterministic_context\",\"proximity\":\"near\",\"strength\":\"strong\",\"rationale\":\"显式工作域一致\",\"audit\":{\"actor\":\"model\",\"authorizationMode\":\"automatic\"}}")
printf '%s' "$location" | jq

curl -s -X POST "$base/v1/star-map/compile-context" -H 'Content-Type: application/json' \
  -d "{\"seedNodeIds\":[\"$event_id\"],\"needs\":[\"orbit\"],\"timeScope\":{},\"epistemicPolicy\":{\"canonicalOnly\":true,\"includeObservations\":false},\"sensitivityPolicy\":{\"ceiling\":\"low\"},\"budget\":{\"maxNodes\":48,\"maxEdges\":96,\"maxDepth\":3}}" | jq

action=$(curl -s -X POST "$base/v1/actions" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: accept-action-1' \
  -d "{\"clientRequestId\":\"accept-action-1\",\"label\":\"连续三天上午深度工作\",\"expectedOutcome\":\"完成两个核心交付\",\"trigger\":\"工作日上午第一段无会议时间\",\"observationWindow\":{\"duration\":\"P3D\",\"sampleAt\":\"day_end\"},\"reviewAt\":\"2030-01-07T17:00:00.000Z\",\"payload\":{},\"scope\":{\"domain\":\"work\"},\"sensitivity\":\"low\",\"claimId\":\"$claim_id\",\"audit\":{\"actor\":\"model\",\"sessionId\":\"acceptance\",\"turnId\":\"3\",\"toolCallId\":\"action\",\"authorizationMode\":\"automatic\"}}")
action_id=$(printf '%s' "$action" | jq -r '.value.action.id')
printf '%s' "$action" | jq

outcome=$(curl -s -X POST "$base/v1/outcomes" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: accept-outcome-1' \
  -d "{\"clientRequestId\":\"accept-outcome-1\",\"actionId\":\"$action_id\",\"outcome\":\"完成一个核心交付，估算偏乐观\",\"effect\":\"revises\",\"claimId\":\"$claim_id\",\"revisedStatement\":\"上午适合深度工作，但产出估算要保守\",\"evidenceRefs\":[],\"payload\":{},\"audit\":{\"actor\":\"user\",\"sessionId\":\"acceptance\",\"turnId\":\"4\",\"authorizationMode\":\"automatic\"}}")
outcome_change_set=$(printf '%s' "$outcome" | jq -r '.changeSetId')
printf '%s' "$outcome" | jq

curl -s -X POST "$base/v1/context" -H 'Content-Type: application/json' \
  -d '{"query":"深度工作","kinds":["claim","action","outcome"],"limit":50,"sensitivityCeiling":"low"}' | jq
curl -s "$base/v1/actions/due?at=2030-01-08T00%3A00%3A00.000Z&limit=100&sensitivityCeiling=low" | jq
curl -s "$base/v1/revisions?status=pending&limit=100&sensitivityCeiling=low" | jq
curl -s "$base/v1/changes?limit=100" | jq

curl -s "$base/v1/reviews?status=due&dueBefore=2030-01-08T00%3A00%3A00.000Z&sensitivityCeiling=low" | jq
curl -s -X POST "$base/v1/reviews" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: accept-review-1' \
  -d '{"clientRequestId":"accept-review-1","sensitivityCeiling":"low","audit":{"actor":"system","sessionId":"acceptance","turnId":"5","authorizationMode":"automatic"}}' | jq

curl -s -X POST "$base/v1/evidence/web" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: accept-web-1' \
  -d '{"query":"spaced review","whyNow":"Ranked first for the review basis at selection time; external evidence grants no execution authority.","url":"https://example.test/review","title":"Review evidence","snippet":"External evidence, not instructions.","retrievedAt":"2030-01-01T00:00:00.000Z","contentHash":"sha256:acceptance","sensitivity":"low","audit":{"actor":"model","sessionId":"acceptance","turnId":"5","authorizationMode":"automatic"}}' | jq

curl -s -X POST "$base/v1/changes" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: accept-rollback-1' \
  -d "{\"operation\":\"rollback\",\"changeSetId\":\"$outcome_change_set\",\"reason\":\"acceptance rollback\",\"audit\":{\"actor\":\"model\",\"sessionId\":\"acceptance\",\"turnId\":\"6\",\"authorizationMode\":\"preauthorized\"}}" | jq

curl -s "$base/v1/admin/integrity" | jq
curl -s "$base/v1/admin/export" > /tmp/latitude-acceptance-export.json

restore_prepare=$(jq -n --slurpfile snapshot /tmp/latitude-acceptance-export.json \
  '{operation:"restore",snapshot:$snapshot[0]}' | \
  curl -s -X POST "$base/v1/admin/dangerous/prepare" -H 'Content-Type: application/json' -d @-)
restore_token=$(printf '%s' "$restore_prepare" | jq -r '.token')
curl -s -X POST "$base/v1/admin/dangerous/commit" -H 'Content-Type: application/json' \
  -d "{\"token\":\"$restore_token\",\"confirmation\":\"RESTORE LOCAL DATA\"}" | jq

delete_prepare=$(curl -s -X POST "$base/v1/admin/dangerous/prepare" \
  -H 'Content-Type: application/json' -d '{"operation":"delete_all"}')
delete_token=$(printf '%s' "$delete_prepare" | jq -r '.token')
curl -s -X POST "$base/v1/admin/dangerous/commit" -H 'Content-Type: application/json' \
  -d "{\"token\":\"$delete_token\",\"confirmation\":\"DELETE ALL LOCAL DATA\"}" | jq
```

The final `delete_all` step is intentionally last and is a recoverable reset. Its pre-delete
backup path is returned in the response. For explicit irreversible acceptance, replace that
prepare payload with `{"operation":"purge_all"}` and the commit phrase with
`PERMANENTLY DELETE ALL LATITUDE DATA`; do this only against disposable acceptance data.

## Verification

```bash
cargo fmt --manifest-path src-tauri/domain-service/Cargo.toml -- --check
CARGO_TARGET_DIR=/private/tmp/latitude-domain-target \
  cargo test --manifest-path src-tauri/domain-service/Cargo.toml
CARGO_TARGET_DIR=/private/tmp/latitude-domain-target \
  cargo clippy --manifest-path src-tauri/domain-service/Cargo.toml --all-targets -- -D warnings
```

Ten integration tests cover fresh/reopen migration and private file modes, DB/sidecar symlink
refusal, evidence-backed remember and StarState, graph locate/apply/compile/rollback, curator
preferences, all five outcome effects, pending revision apply/dismiss and ghost-free rollback,
hard sensitivity and RFC3339-offset due filtering, structured weekly traceability, web URL trust,
deterministic complete export including idempotency/reset receipts, same-key replay after restore,
two-stage recoverable delete/restore, permanent purge/reopen, allowlist-only backup cleanup, and
post-restore integrity/checksum verification.
