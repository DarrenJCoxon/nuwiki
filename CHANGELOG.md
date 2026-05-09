# Changelog

All notable changes to `@nusoft/nuwiki` will be documented here.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows semantic versioning.

## [0.1.4] — 2026-05-09

### Changed — `@nusoft/nuvector` dependency now uses caret range

Dependency on `@nusoft/nuvector` changed from exact `"0.1.3"` to `"^0.1.3"`. No behavioural change in this package; the change lets downstream consumers (notably `@nusoft/nuos`) declare a higher caret range without npm losing the ability to dedupe NuVector copies in `node_modules`.

Mirror of the same fix shipped in `@nusoft/nuflow@0.4.1` ([WU 131](https://github.com/DarrenJCoxon/nuos/blob/main/docs/build/work-units/done/131-cross-package-coordination-cleanups.md)) and surfaced again here during [WU 133](https://github.com/DarrenJCoxon/nuos/blob/main/docs/build/work-units/133-comprehensive-nuos-trifecta-integration.md) (the comprehensive `@nusoft/nuos` trifecta integration via `createNuOS`). Same root cause, same fix; the trifecta is now consistent.

The exact-pin pattern is rejected as a NuOS convention going forward. Producers express compatibility with carets; consumers that need to lock a specific transitive version do so in their own `package.json`.

## [0.1.3] — 2026-05-05

### Changed

- Bumped `@nusoft/nuvector` to `0.1.3` to pull in the postgres `metadataMatch` filter fix (tenant-internal isolation).

## [0.1.0] — 2026-05-04

First public release. The NuWiki compilation engine, all five adapters, the seven quality layers, the WikiPack extension surface, and the 17/17 contract conformance suite.

### Foundation (WU 030)

- Repository scaffolding, type surface, adapter interfaces; every public method initially stubbed with `NotImplementedError` pointing at the implementing WU.

### Adapter layer (WU 031–035)

- **WU 031** — `MetadataAdapter` Postgres reference impl (`@nusoft/nuwiki/postgres`). Articles + versions + backlinks schema, tenant isolation, ON DELETE CASCADE, backlink-count subquery.
- **WU 032** — `ObjectStorageAdapter` reference impls (`@nusoft/nuwiki/storage`): SharePoint (Microsoft Graph), Google Drive, Supabase Storage, in-memory. Generic `HttpClient` + per-call `getAuthToken()`. No bundled provider SDKs.
- **WU 033** — `NuVectorAdapter` thin wrapper (`@nusoft/nuwiki/nuvector`) over `@nusoft/nuvector`. `markSuperseded` is a documented no-op (NuVector handles supersession via `supersedesId`); `graph.archiveNode` / `removeNode` invoke `memory.delete` with the article id.
- **WU 034** — `LLMAdapter` reference impls (`@nusoft/nuwiki/llm`): Vertex AI (Tier 2 cloud, `europe-west2` default), OpenAI-compatible (Tier 1 — Ollama, vLLM, OpenRouter), deterministic stub. Both production adapters are model-agnostic per D020 — `generationModel` and `embeddingModel` are required.
- **WU 035** — `DatabaseSourceAdapter` (`@nusoft/nuwiki/database-source`): handler-map dispatch by named query kind, in-memory fixture-backed adapter, deterministic stub. No SQL reference — source queries are typed domain operations the consumer wraps with their existing data-access layer.

### Compilation engine (WU 036)

- `CompilationEngine` orchestrating the contract's compile-and-publish flow: resolve sources → fetch existing version → call LLM with `LLM_COMPILATION_OUTPUT_SCHEMA` → embed → store body + structured JSON → upsert metadata → atomic publish-to-NuVector (`upsertBatch` layers 1–3 + `graph.upsertNodeWithEdges` + `remember` + `markSuperseded`).
- `NuWiki` runtime methods: `compile`, `refresh`, `list`, `archive`, `delete`, `affectedDocuments`.
- Failure modes: unknown documentType, parse failure, source-resolution failure, body/metadata write failure, NuVector publish failure → article `blocked` with structured warning; no partial state.

### Quality layers (WU 037–043)

- **WU 037** — Token budget enforcement on `summaryTokenBudget`; over-budget → `over_budget_summary` warning; zero downstream side effects. `tokenCounter` injection point on `NuWikiConfig`. Model-agnostic estimator.
- **WU 038** — Section-summary-prefix invariant; layer-2 embeddings computed on `[Article: <summary>]\n<heading>: <text>`. `embedSectionsWithSummaryPrefix` per-DocumentType opt-out.
- **WU 039** — Citation validation (`validateCitations`): orphan section→citation, orphan citation, source not retrieved, empty claim, invalid confidence. Failures return `blocked`; structured `details.issueKind` for downstream routing.
- **WU 040** — Backlink graph maintenance + `wiki.followLinks`. Inverse `recordBacklink` writes; `removeBacklinksFor` on recompile; non-fatal `broken_backlink` warnings via `BrokenLinkChecker`.
- **WU 041** — Role-aware redaction + `wiki.read`. `redactArticle` applies article-level `excludedRoles` / role-not-in-defaults hide / per-section `RoleRedactionRule` actions. `limited_view` warning emitted on any redaction. Structured-form JSON companion alongside the markdown body in object storage.
- **WU 042** — Integrity pass loop + `wiki.runIntegrityPass`. Canonical check set: `missing_evidence`, `stale_article`, `broken_backlink`, `uncited_claim`, `orphan_article`, `duplicate_subject_articles`. Per-kind severity policy. Auto-remediation for `stale_article` / `uncited_claim` re-runs `compile`.
- **WU 043** — Article-suggestion engine + `wiki.suggestNewArticles`. LLM-driven gap detection over the corpus; existing articles filtered out; each suggestion stamped with `suggestedAt`.

### Domain-neutral core (WU 044)

- `WikiPack` interface + `defineWikiPack` helper (`@nusoft/nuwiki/pack`). Domain DocumentTypes live in separately published packs — the `./templates` subpath that early scaffolding had reserved is removed. Mirrors NuFlow's `WorkflowPack` pattern from D015.

### Conformance (WU 045)

- 17/17 contract conformance suite at `tests/wu-045-conformance.test.js`, one section per required test in the contract. §17 opens a real `@nusoft/nuvector` in-memory instance and verifies the trifecta integration boundary.
- Canonical green line: `WU 045 — NuWiki conformance: 17/17 contract conformance points verified` — CI / publish gates grep for it.

### Documentation (WU 046)

- README rewritten end-to-end against the v0.1.0 surface. Quick-start snippet, per-adapter wiring, `WikiPack` usage, role-aware redaction with the IdP→token→middleware safety chain, publish-to-NuVector contract, forbidden-behaviours list.
- This `CHANGELOG.md` added; included in the pack `files` allowlist.

### Architectural commitments touched

- **D015** (workflow packs are a first-class extension surface) — amended at this release to extend over NuWiki via `WikiPack` (WU 044). Domain content lives in packs across both NuFlow and NuWiki.
- **D018** (document store is a first-class adapter) — informs the WU 032 storage reference impls.
- **D020** (NuOS packages are model-agnostic by design) — informs the WU 034 LLM adapter design and the WU 037 token-counter injection point.

### Verification

220/220 tests passing. Pack verifier passes the v0.1.0 surface (no `child_process` / `exec` / `spawn` / heritage terms).
