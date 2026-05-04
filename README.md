# @nusoft/nuwiki

The compiled knowledge engine of NuOS — an LLM-maintained, cited, role-aware substrate of institutional understanding. Articles are derived from authoritative sources, never replacing them; every article publication produces an atomic four-layer index update in NuVector so agents can retrieve compiled understanding in milliseconds and a few hundred tokens.

> **v0.1.0 status: scaffolding skeleton.** This package establishes the type surface and the public API shape (WU 030 of the NuOS programme). The runtime — compilation, integrity passes, role-aware redaction, NuVector publish — lands in WUs 031–047. Each public method on `NuWiki` currently throws a `NotImplementedError` pointing at the WU that will implement it.

## What NuWiki is

The seed insight (Karpathy):

> Raw data from a given number of sources is collected, then compiled by an LLM into a .md wiki, then operated on by various CLIs by the LLM to do Q&A and to incrementally enhance the wiki. You rarely ever write or edit the wiki manually, it's the domain of the LLM.

NuWiki is the institutional version of that pattern. It is **not** a place where humans go to read documents. It is the knowledge substrate that **agents read** when they need to understand context, answer questions, draft proposals, or maintain awareness of an institution. NuFlow workflows, consumer chat surfaces, briefing generators, evidence pack drafters — all read NuWiki, primarily by retrieving NuVector layer-1 article summaries.

## What NuWiki is not

- **Not a wiki in the user-edited sense.** Confluence, Notion, Obsidian — those are tools where humans author. NuWiki articles are LLM-maintained from authoritative sources.
- **Not the source of truth.** Every NuWiki claim is derived. If an article and the database disagree, the database wins.
- **Not a documentation system.** It is for the institutional knowledge of the consumer's domain.
- **Not primarily a UI.** Its main consumer is agents.
- **Not a search engine.** Retrieval over NuWiki is performed by NuVector via the four-layer hierarchy.

## Public surface (v0.1.0 — types only; runtime stubbed)

```ts
import { NuWiki } from "@nusoft/nuwiki";

const wiki = await NuWiki.open({
  metadata: prismaClient,           // article metadata in Postgres (WU 031)
  bodies: supabaseStorage,          // article bodies in object storage (WU 032)
  memoryAdapter: nuvectorAdapter,   // for source retrieval and atomic four-layer publish (WU 033)
  llmAdapter: vertexAiAdapter,      // for compilation (WU 034)
  tenant: "school_bridge",
  documentTypes: myPack.documentTypes,  // (WU 044 — via WikiPack)
});

// Each of these methods throws NotImplementedError at v0.1.0;
// the WU that implements each is named in the error message:
await wiki.compile({ ... });          // WU 036
await wiki.read({ ... });             // WU 041
await wiki.followLinks({ ... });      // WU 040
await wiki.refresh({ ... });          // WU 036
await wiki.affectedDocuments(...);    // WU 036/040
await wiki.runIntegrityPass({ ... }); // WU 042
await wiki.suggestNewArticles({...}); // WU 043
await wiki.list({ ... });             // WU 031
await wiki.archive({ ... });          // WU 036
await wiki.delete({ ... });           // WU 036
await wiki.export(id, "pdf");         // post-v0.1.0
```

## Subpath imports

```ts
import { defineWikiPack } from "@nusoft/nuwiki/pack";            // WU 044
import { NuWikiAgentTools } from "@nusoft/nuwiki/agent-tools";    // post-v0.1.0
import { NuWikiExport } from "@nusoft/nuwiki/export";             // post-v0.1.0
import { NuWikiObsidian } from "@nusoft/nuwiki/obsidian";         // post-v0.1.0
```

All subpaths are declared and importable at v0.1.0; their concrete implementations land later.

## Adapters

Five adapters compose NuWiki into a NuOS deployment. Reference implementations land in WUs 031–035:

- **`MetadataAdapter`** — article metadata in the consumer's relational database (Postgres reference impl, WU 031)
- **`ObjectStorageAdapter`** — article bodies and exports (SharePoint / Drive / Supabase Storage reference impls per [D018](https://github.com/your-org/nuos/blob/main/docs/build/decisions/D018-document-store-as-first-class-adapter.md), WU 032)
- **`NuVectorAdapter`** — wraps `@nusoft/nuvector` for source retrieval, atomic four-layer publish, and provenance (WU 033)
- **`LLMAdapter`** — for compilation and embeddings (WU 034)
- **`DatabaseSourceAdapter`** — direct queries to the consumer's database (WU 035)

The interface shapes are fixed at WU 030 (this package); the implementations land per-WU.

## The publish-to-NuVector contract

The most important integration boundary in NuOS. When NuWiki publishes a new article version, it must atomically execute a six-phase NuVector write (embeddings → batch upsert into layers 1–3 → graph upsert → provenance → supersede prior version → invalidation broadcast). If any phase fails, the whole publication rolls back. The contract details are in `nuos/docs/contracts/nuwiki.md §The publish-to-NuVector contract`.

## License

MIT
