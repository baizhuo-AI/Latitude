# Latitude browser product closure

Status: implementation authority for the current local-browser P0.

## Authority order

1. The user's latest explicit constraints in this task.
2. The product master specification, except where those constraints revise scope or approval mode.
3. The unified knowledge-star-map delivery package's domain contracts and test cases.
4. Existing implementation, which is evidence rather than a promise.

The delivery package is a design and contract package. It is not evidence that the feature already exists.

## Current P0 boundary

- Acceptance happens in a local browser backed by loopback-only local services.
- Tauri packaging, signing, Feishu, Kiro, Computer History, audio capture, and real-user metrics are deferred.
- Storage and control are local-first. DeepSeek inference and web search are explicit external outbound operations.
- The Agent Host defaults to `deepseek-v4-flash`; `DEEPSEEK_MODEL` is the explicit override. The supported `dev:local` launcher filters credential-shaped variables from the Browser/Domain parent environment and re-adds only the four DeepSeek provider variables from that credential class to the Agent Host; the Domain launcher filters again before entering Rust. Service scripts and Vite still read `.env.local`, while only `VITE_*` reaches the Browser bundle, so `.env.local` is not a general-purpose secrets file and no model credential may use a `VITE_*` name.
- The model may automatically change long-term knowledge under a standing `automatic` or `preauthorized` grant. Every change must retain actor, provenance, evidence, before/after, inverse operation, version, and a rollback path. A model inference remains `authority=system_inferred` and can never impersonate `user_confirmed`.
- AI-authored UI changes use a validated declarative `UiChangeSet`; P0 does not execute arbitrary model-authored JavaScript.
- The production UiSurfaceV2 has exactly 15 host-owned components: five LayoutV1 cards; the left secretary rail (kept under the stable compatibility id `secretary-companion`); and nine fixed modules for the Browser control strip, candidate strip, thread, outcome dialog, diagnostics, data safety, command bar, dimension navigation, and source inspector. The adapter still projects only the five cards into LayoutV1. The secretary retains its existing art and can collapse to a 44px rail; its old drag-position data remains profile-compatible but no longer controls Browser rendering. The secretary and fixed modules accept only visibility plus their exact trusted action bindings; model-authored layout, props, arbitrary commands, and code remain invalid. The fixed composition-recovery entry stays outside the mutable surface so hidden modules can always be restored.
- Existing Latitude art direction is the visual baseline.

## Runtime boundary

```text
React living UI
    -> loopback Agent Host (DeepSeek Harness query/session/tool/web seams)
        -> stable DomainPort
            -> loopback Rust/Axum domain service
                -> versioned SQLite
```

DSH owns the recoverable agent loop, session events, prompt/tool seams, budgets, and provider adapters. Latitude owns the knowledge graph, ChangeSets, temporal review rules, and UI documents. Neither DSH session history nor a frontend store is a second source of domain truth.

An ordinary user turn has a hard phase lock between untrusted web evidence and local mutation. Attempting `web_search` locks out all mutating Domain/UI tools for the rest of that turn; attempting a mutating tool locks out `web_search`. A failed attempt still locks the phase, so continuing requires a new user turn. The scheduler's bounded daily-curation tool is a separate restricted path, not an exception available to ordinary turns.

## Executable acceptance path

A P0 build is accepted only when the combined hermetic Browser gate and real-provider gate establish this path on fresh isolated profiles. The hermetic gate may inject a provider at the programmatic Host seam, but no Browser, HTTP, scheduler, Domain, persistence, or DOM step may be mocked; real-provider behavior is proved separately and never inferred from that injected provider:

1. Capture evidence or a user statement.
2. Derive an observation or claim with visible provenance.
3. Surface a tension and generate a candidate intervention.
4. Create an action or experiment with required `trigger`, `observationWindow`, `expectedOutcome`, and `reviewAt`.
5. Collect an outcome at the event boundary, with a calendar fallback when no event arrives.
6. Record one of `confirms`, `contracts`, `revises`, `refutes`, or `unknown`. `contracts` and `revises` require the replacement statement; `unknown` remains pending. Preserve the former state and inverse.
7. Produce a real weekly review from unresolved and completed loops, or return an explicit empty-week projection without inventing a review.
8. Refresh and restart all local services; the same state and audit trail remain readable.
9. Roll back one model-authored knowledge change and one AI-authored UI change.
10. Export the complete profile, restore it into a clean profile, verify integrity, and prove the browser bundle/localStorage/API responses contain no credential.

## Time design

- `T0`: creating an action or experiment requires a concrete `trigger`, an `observationWindow`, an `expectedOutcome`, and `reviewAt`.
- Event clock: explicit completion, a recorded result, or a relevant new evidence event triggers outcome collection immediately.
- Calendar fallback: at `reviewAt`, ask once for missing evidence. If the user stays silent, keep the outcome explicitly missing and stop repeated pressure; never fabricate silence into a result.
- Candidate cadence: a typed intervention moves only by an explicit `proposed → touched → shaping → concluded / parked` command. Three days of proposed silence and seven days in shaping each create at most one durable prompt receipt; acknowledging delivery does not advance or park the candidate.
- Local revision: an outcome immediately evaluates only the claims, tensions, and decisions linked to that action.
- Weekly review: every seven days, collect open result windows, overdue follow-ups, changed claims, contradictions, and actions without evidence into structured single-loop and double-loop sections.
- Empty week: automatic scheduling requires at least one sensitivity-eligible loop artifact. Otherwise `latestCompleteWeek.status=empty` and `eligibleArtifactCount=0`; no generic review or outbox item is fabricated. An explicit user may still request a manual review.
- Monthly arc: summarize direction and recurring patterns; it never rewrites canonical facts without its own ChangeSet.

### Why this cadence

- Actions store a cue as well as a deadline because implementation-intention research shows that linking a concrete situation to a response helps translate intention into action; the product expresses that as `trigger` + `expectedOutcome`, not as motivational prose ([Gollwitzer, 1999](https://bpb-us-e1.wpmucdn.com/wp.nyu.edu/dist/c/6235/files/2019/02/gollwitzer-1999-implementation-intentions.pdf)).
- Event-triggered collection is primary and calendar time is the fallback. Prospective-memory research distinguishes event and time cues and finds that time-based tasks require active clock monitoring; the system should carry that monitoring cost instead of asking the user to remember ([McBride & Flaherty, 2020](https://pubmed.ncbi.nlm.nih.gov/32701016/)).
- The first outcome prompt stays close to the event because momentary/experience-sampling reports reduce several retrospective recall biases. A later weekly synthesis may interpret the record, but it must not overwrite the original near-event observation ([Trull & Ebner-Priemer, 2009](https://pmc.ncbi.nlm.nih.gov/articles/PMC4255457/)).
- A weekly review is a deliberate product cadence rather than a claim that seven days is a universal cognitive optimum. It combines evidence that progress monitoring improves goal attainment with a natural calendar landmark that can support renewed goal pursuit ([Harkin et al., 2016](https://eprints.whiterose.ac.uk/id/eprint/91437/); [Dai, Milkman & Riis, 2014](https://faculty.wharton.upenn.edu/wp-content/uploads/2014/06/Dai_Fresh_Start_2014_Mgmt_Sci.pdf)).
- Monthly arcs are for pattern visibility only. The research above does not justify automatically converting a recurring correlation into a canonical causal belief; that still requires evidence and a ChangeSet.

## Release gates for this P0

- `npm run verify:code` passes: production Browser build, a post-build credential-shaped artifact scan of `dist/` and optional `build/`, CSS contract, Browser/Agent TypeScript, full Vitest, and Rust fmt/clippy/integration tests. The scanner never reads `.env.local`, and a finding reports only file, detector, and count rather than the matched value. This gate uses fakes and does not call a real model or web provider.
- `npm run accept:browser` is the repeatable no-key rendered smoke gate. It reserves three distinct OS-selected loopback ports, injects the resulting Agent/Domain URLs into the production Browser build, passes the Browser port to Domain's exact CORS, and then starts an isolated real Domain profile plus an explicitly labelled outbound-free Agent bootstrap test double. A system Chrome process must render the seeded due action, submit an outcome through the real DOM, and pass Domain readback, console-exception, and external-request checks. Screenshots are diagnostic only. It never reuses, terminates, or overwrites an unknown local process, and it is a narrow rendered smoke rather than a complete Agent E2E.
- `npm run accept:offline` is the deterministic no-provider functional E2E gate. Only its dedicated child executable injects stateful fake model/search adapters; production HTTP and environment variables expose no fake selector. It runs the production Browser, real Agent HTTP + DSH/Cordis loop, durable scheduler, real Domain/SQLite and CDP-driven DOM through one continuous path: message receipt → Claim + four-field action → linked EvidenceEvent → outcome push/ack → result + revision → weekly review → persisted immutable Web `whyNow` → `candidate_propose` + Browser touch/park → 15-component UI CAS → deep complete export → credential-free IndexedDB recovery copy → Domain/Agent/Browser clear → all three restart clean → Browser two-stage recent-backup restore → all three restart and exact session/Claim/parked-candidate/UI/whyNow readback. It fails closed unless macOS `sandbox-exec` is active and every descendant probe is OS-denied: fetch, HTTP, HTTPS, net, TLS, WebSocket, both Undici APIs, child-process networking, an unknown loopback port, a real DNS UDP/53 packet, and an existing Unix socket. The three Agent starts yield 36 denied probes total while the exact Domain loopback health request remains reachable. Acceptance Chrome alone adds `--no-sandbox` because Chrome's nested renderer Seatbelt cannot start inside the outer profile; isolation is replaced by the inherited exact-port Seatbelt rather than removed, and no development or release launcher carries this flag. This proves product orchestration, persistence and hermeticity, not real DeepSeek authentication, real Web Search quality, or final human visual quality.
- `npm run accept:local` passes with a real DeepSeek key: it uses an owned temporary profile to exercise real Agent and Web provider calls plus Domain closure, model memory rollback, a UiSurfaceV2 change resource containing a secretary visibility operation, restart readback, Domain/Agent export/restore, and credential leakage scanning. It does not launch the Browser UI or apply that resource as a rendered Browser document.
- Manual Browser acceptance is a separate visual/provider gate: launch `npm run dev:local`, inspect the retained art and left secretary rail, and complete representative turns through the real provider. `accept:offline` is a real production-Browser functional E2E driven over CDP, but screenshots are diagnostic; it must not be reported as human aesthetic or usability acceptance.
- The browser uses real loopback services rather than the preset/demo fallback.
- Agent turns have step, tool, output, and wall-clock budgets; interruption and restart are recoverable.
- All domain writes go through one transactional ChangeSet API.
- Search results enter the graph as untrusted external evidence with URL, title, published/retrieved time, query, and content hash.
- The feed is deduplicated, source-linked, limited to three items, and records feedback into curator preferences. Its durable scheduler checks once at local 09:00 with startup/restart compensation, using only `low`-sensitivity goal, tension, and curator-preference basis; missing basis or no novel results produces no push rather than guaranteed daily content. Every new item persists the bounded Host ranking-time `whyNow` through `/v1/evidence/web`; restart reads that immutable reason, while pre-contract records show an explicit `LEGACY` notice instead of being rewritten from the current tension or query.
- Data export/restore/delete/integrity cover the full graph, conversations, sessions, 15-component UI documents, reviews, and audit receipts. Before `delete_all` can even prepare service tokens, the Browser must persist and read back one credential-free complete profile in IndexedDB; a new page/coordinator can restore that latest backup through the same two-stage confirmation. Any save/readback failure blocks the clear. `purge_all` must remove that Browser recovery copy as well as service-owned backups. A permanent-delete result is complete only when Domain, Agent, and Browser all report complete; Agent/Domain `partial`, `recoverable`, and preserved-entry receipts remain visible and are never relabelled as success. The downloaded complete export is unencrypted plaintext JSON and must say so in both the deep data-safety entry and completion notice.

## Explicitly deferred approvals

No user approval is needed during the local implementation for reversible repository changes or loopback tests. At handoff, list any remaining external actions such as rotating the previously exposed key, enabling paid search/model usage, signing a Tauri app, or connecting a Feishu tenant.
