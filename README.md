# @nusoft/nuwiki

The compiled knowledge engine of NuOS. NuWiki maintains a living, cited, role-aware substrate of institutional understanding — derived from authoritative sources, never replacing them — and publishes every article into NuVector's four-layer index so agents can retrieve compiled understanding in milliseconds and a few hundred tokens.

NuWiki is the third deep module of the NuOS trifecta: NuVector (memory), NuFlow (workflow), NuWiki (knowledge).

## Install

```bash
npm install @nusoft/nuwiki @nusoft/nuvector
```

## Quick start

```ts
import { NuWiki } from "@nusoft/nuwiki";
import { NuWikiMetadataPostgres } from "@nusoft/nuwiki/postgres";
import { SupabaseObjectStorageAdapter } from "@nusoft/nuwiki/storage";
import { createNuVectorAdapter } from "@nusoft/nuwiki/nuvector";
import { VertexAILLMAdapter } from "@nusoft/nuwiki/llm";
import { createDatabaseSourceAdapter } from "@nusoft/nuwiki/database-source";
import { NuVector } from "@nusoft/nuvector";

const memory = await NuVector.open({
  storage: "postgres://…",
  dimensions: 768,
  tenant: "school_bridge",
});

const wiki = await NuWiki.open({
  metadata: await NuWikiMetadataPostgres.open({ connectionString: "postgres://…", tenant: "school_bridge" }),
  bodies:   new SupabaseObjectStorageAdapter({ baseUrl: "https://…supabase.co/storage/v1", bucket: "nuwiki", getAuthToken: async () => process.env.SUPABASE_KEY }),
  memoryAdapter: await createNuVectorAdapter(memory),
  llmAdapter: new VertexAILLMAdapter({
    projectId: "my-gcp-project",
    generationModel: "gemini-flash-3",   // model-agnostic — see D020
    embeddingModel:  "text-embedding-005",
    getAuthToken: async () => gcpToken(),
  }),
  databaseSource: createDatabaseSourceAdapter({
    handlers: {
      pupil_recent_incidents: async ({ pupilId, windowDays }) => ({
        rows: await prisma.incident.findMany({ where: { pupilId, since: daysAgo(windowDays) } }),
      }),
    },
  }),
  tenant: "school_bridge",
  documentTypes: educationSenPack.documentTypes,   // contributed by a WikiPack — see D015
});

// Compile or refresh an article (typically called by NuFlow after a workflow commit)
await wiki.compile({
  documentType: "pupil_profile",
  subject: { kind: "pupil", id: "p_456" },
  trigger:  { kind: "workflow_commit", workflowId: "wf_001", intentType: "incident.peer_conflict.record" },
});

// Read an article — role-aware redaction applied per the DocumentType's RoleRedactionRule set
const article = await wiki.read({
  documentType: "pupil_profile",
  subject: { kind: "pupil", id: "p_456" },
  viewerRole: "teaching_assistant",   // verified server-side — never client-supplied
});
```

## What NuWiki is, and is not

NuWiki **is** the institutional knowledge substrate — agent-first, LLM-maintained, cited, role-redacted, indexed atomically into NuVector's four layers as it compiles. Karpathy's "compile sources into a wiki the LLM operates on" pattern, applied to a regulated domain.

NuWiki is **not** a Confluence / Notion clone. Staff almost never write into NuWiki directly. It is read primarily by agents — workflow runtimes, briefing generators, evidence-pack drafters — and surfaces to humans as the citation-rich answers those agents produce.

NuWiki is **not** the source of truth. Every claim derives from a record in the consumer's database, in object storage, or in NuVector. If the source disagrees, the source wins, the article recompiles, the previous version is archived for audit.

## The public surface

```ts
class NuWiki {
  static async open(config: NuWikiConfig): Promise<NuWiki>;
  registerDocumentType(definition: DocumentType): void;
  listDocumentTypes(): DocumentType[];

  compile(request: CompileRequest):                Promise<CompilationResult>;
  refresh(ref: RefreshRef):                        Promise<RefreshResult>;
  read(request: ReadRequest):                      Promise<RenderedArticle>;
  followLinks(request: FollowLinksRequest):        Promise<RenderedArticle[]>;
  list(filters: ListFilters):                      Promise<NuWikiArticle[]>;
  archive(request: ArchiveRequest):                Promise<void>;
  delete(query: DeletionQuery):                    Promise<DeletionResult>;
  affectedDocuments(commit, intent):               Promise<KnowledgeRef[]>;
  runIntegrityPass(request: IntegrityPassRequest): Promise<IntegrityPassResult>;
  suggestNewArticles(scope: SuggestionScope):      Promise<ArticleSuggestion[]>;
  export(articleId: string, format: ExportFormat): Promise<ExportRef>;   // post-v0.1.0
}
```

## Adapters

Five adapter contracts. Reference implementations ship under subpaths; consumers wire their own when needed.

| Subpath | What it covers | Reference impl(s) |
|---|---|---|
| `@nusoft/nuwiki/postgres` | `MetadataAdapter` — articles + versions + backlinks in a relational DB | `NuWikiMetadataPostgres` (pg) |
| `@nusoft/nuwiki/storage` | `ObjectStorageAdapter` — article bodies + structured JSON | SharePoint, Google Drive, Supabase, in-memory (D018) |
| `@nusoft/nuwiki/nuvector` | `NuVectorAdapter` — atomic four-layer publish + retrieval + graph | `NuWikiNuVectorAdapter` over `@nusoft/nuvector` |
| `@nusoft/nuwiki/llm` | `LLMAdapter` — generation + embeddings | Vertex AI (Tier 2), OpenAI-compatible (Tier 1 / Ollama / vLLM / OpenRouter), stub |
| `@nusoft/nuwiki/database-source` | `DatabaseSourceAdapter` — typed/named queries against the consumer's domain DB | handler-map, in-memory, stub |

Construction pattern across all five: generic `HttpClient` (`globalThis.fetch` default), per-call `getAuthToken()`, no bundled provider SDKs. Drop in your own auth strategy without forking. Per **D020**, no specific model name is hardcoded — `generationModel` and `embeddingModel` are required config.

## Wiki packs (D015 / WU 044)

NuWiki core is **domain-neutral**. DocumentTypes live in separately published packs — same pattern NuFlow uses for workflow packs.

```ts
import { defineWikiPack } from "@nusoft/nuwiki/pack";

export const educationSenPack = defineWikiPack({
  name: "education-sen",
  version: "0.1.0",
  description: "DocumentTypes for SEN schools",
  documentTypes: [pupilProfile, peerConflictPattern, classBriefing, annualReviewPack, policySummary],
});
```

Consumers install the pack and pass `pack.documentTypes` to `NuWiki.open`. Third parties can publish packs under their own scope (e.g. `@my-mat/nuwiki-pack-mainstream-school`).

## Role-aware redaction (WU 041)

Different viewer roles see different bodies. The `DocumentType.visibility.excludedRoles` and per-section `RoleRedactionRule` actions (`show` / `hide` / `redact` / `summarise`) are applied by `redactArticle` inside `wiki.read()`. Citations and outbound links from hidden sections are stripped. A `limited_view` warning surfaces when redaction has occurred.

**The safety chain.** NuWiki *honours* a role string; it does not authenticate it. The integrity of "this person actually holds this role on this request" must be enforced upstream:

```
1. Identity provider (Entra / Workspace) — role attribute provisioned by HR / leadership
                  ↓
2. Server backend mints a short-lived signed token with the role claim
                  ↓
3. Single middleware verifies the token + extracts the role on every request
                  ↓
4. NuWiki.read({ viewerRole }) — role string is the verified claim, never client input
```

A request that names a role the token doesn't carry is rejected at the boundary. The role passed to `wiki.read` is the verified claim, full stop. This is documented as a deployment requirement, not an in-package check.

## The publish-to-NuVector contract

When NuWiki publishes a new article version, the engine performs an **atomic four-layer publish**:

```
embed(summary)                                        — layer 1 (article summary)
embed([Article: <summary>] + section)  for each       — layer 2 (sections, with prefix invariant)
embed(citation.claim)                  for each       — layer 3 (citations; if precisionIndexable)
upsertBatch([summary, ...sections, ...citations])     — single batch into NuVector
graph.upsertNodeWithEdges({ articleId, outboundLinks })  — layer 4 (article graph)
remember({ kind: "nuwiki_compile", evidence, … })     — provenance
markSuperseded(predecessor)                           — atomic supersession of v(N-1)
```

If any phase throws, the article is flipped to `blocked` with a `compilation_blocked` warning. Partial state is never visible to readers — the predecessor version remains the canonical view until publish succeeds.

## Quality layers

| Layer | WU | What it does |
|---|---|---|
| Token budget enforcement | 037 | Over-budget summaries → `over_budget_summary` warning; no publish |
| Section-summary-prefix invariant | 038 | Layer-2 embeddings include `[Article: <summary>]` prefix |
| Citation validation | 039 | Five rules: orphan section→citation, orphan citation, source not retrieved, empty claim, invalid confidence |
| Backlink graph maintenance | 040 | `recordBacklink` per outbound link; `broken_backlink` warning for missing/archived targets |
| Role-aware redaction | 041 | Per-section actions; `limited_view` warning |
| Integrity pass | 042 | `runIntegrityPass` with `stale_article` / `duplicate_subject_articles` / `uncited_claim` / etc.; auto-remediation for stale/uncited via recompile |
| Article suggestion | 043 | `suggestNewArticles` — LLM-driven gap detection over the corpus |

## Forbidden behaviours (structural commitments)

NuWiki **must not**:

- Ship domain-specific `DocumentType` definitions in core (D015 — packs only)
- Hardcode any model name as a default (D020 — `generationModel` / `embeddingModel` are required)
- Trust a `viewerRole` from client input — must be a server-verified claim
- Publish a partial state across the four NuVector layers — atomic or `blocked`
- Embed a section without the `[Article: <summary>]` prefix when `embedSectionsWithSummaryPrefix !== false` (the contract default is true)
- Publish an over-budget summary — fails compilation with `over_budget_summary`
- Mutate a published version — versions are immutable; supersession is by new version

## Conformance

The contract conformance suite at `tests/wu-045-conformance.test.js` runs 17 sections, one per required test in the contract. Section 17 (composition) opens a real `@nusoft/nuvector` in-memory instance and verifies retrievability of a refreshed article through NuVector layer 1.

The suite ends with the canonical line:

```
WU 045 — NuWiki conformance: 17/17 contract conformance points verified
```

CI / publish gates grep for that line.

## Programme position

NuWiki is Phase 2 of the NuOS programme. Phases 0 (NuVector) and 1 (NuFlow) are complete; v0.1.0 of NuWiki publishes via WU 047. The trifecta integration test (Phase 4 / WUs 060–064) is the final gate before the consumer-shell MVP build begins.

## Licence

MIT — see `LICENSE`.
