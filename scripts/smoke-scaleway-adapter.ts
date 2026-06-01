/**
 * Smoke harness — WU 141 AC 5 / AC 6.
 *
 * Library-level end-to-end smoke: ScalewayLLMAdapter → NuWiki seed() →
 * compile() → semantic retrieval against a temporary Docker-backed pgvector
 * index.
 *
 * Run:
 *   cd nuwiki && npx tsx scripts/smoke-scaleway-adapter.ts
 *
 * Requires:
 *   SCW_SECRET_KEY, SCW_DEFAULT_PROJECT_ID env vars set
 *   Docker available (pgvector/pgvector:pg16 image pre-pulled)
 *   pg package: npm install pg (run once before this script)
 *   @nusoft/nuwiki-pack-education-statutory: npm install once before running
 *
 * Local-dev peer-dep resolution:
 *   The statutory pack imports `@nusoft/nuwiki` at runtime. When running
 *   from a fresh clone of nuwiki (where the local package is the one
 *   under development), create a symlink so the pack resolves to this
 *   working copy rather than a published version:
 *
 *     ln -s "$(pwd)" node_modules/@nusoft/nuwiki
 *
 * Exit code 0 = all steps passed.
 * Exit code 1 = one or more steps failed (details in JSON output).
 */

import { execSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Fail-fast on missing env vars
// ---------------------------------------------------------------------------

const SCW_SECRET_KEY = process.env.SCW_SECRET_KEY;
const SCW_DEFAULT_PROJECT_ID = process.env.SCW_DEFAULT_PROJECT_ID;

if (!SCW_SECRET_KEY || SCW_SECRET_KEY.trim() === '') {
  console.error('FATAL: SCW_SECRET_KEY is not set or empty');
  process.exit(1);
}
if (!SCW_DEFAULT_PROJECT_ID || SCW_DEFAULT_PROJECT_ID.trim() === '') {
  console.error('FATAL: SCW_DEFAULT_PROJECT_ID is not set or empty');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Result collector
// ---------------------------------------------------------------------------

interface StepResult {
  step: string;
  pass: boolean;
  durationMs?: number;
  detail?: unknown;
  error?: string;
}

const results: StepResult[] = [];
let dockerContainerId: string | null = null;

function step(name: string): (pass: boolean, detail?: unknown) => void {
  const t0 = Date.now();
  return (pass, detail) => {
    results.push({ step: name, pass, durationMs: Date.now() - t0, detail });
  };
}

// ---------------------------------------------------------------------------
// Cleanup helper — runs even on failure
// ---------------------------------------------------------------------------

async function cleanup() {
  if (dockerContainerId) {
    try {
      execSync(`docker stop ${dockerContainerId}`, { stdio: 'pipe' });
      console.log(`[cleanup] Docker container ${dockerContainerId} stopped`);
    } catch (e) {
      console.error('[cleanup] Failed to stop Docker container:', (e as Error).message);
    }
    dockerContainerId = null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const smokeStart = Date.now();

async function main() {
  // ─────────────────────────────────────────────────────────────────────────
  // Step 1: Construct ScalewayLLMAdapter from env vars
  // ─────────────────────────────────────────────────────────────────────────
  const s1 = step('Step 1: Construct ScalewayLLMAdapter from SCW_* env vars');
  let adapter: import('./src/llm.js').ScalewayLLMAdapter;
  try {
    const { parseScalewayCredentialsFromEnv } = await import('../dist/src/scaleway-config.js');
    const { ScalewayLLMAdapter } = await import('../dist/src/llm.js');
    const creds = parseScalewayCredentialsFromEnv(process.env as NodeJS.ProcessEnv);
    adapter = new ScalewayLLMAdapter({
      ...creds,
      maxRetries: 5,
      baseRetryDelayMs: 1000,
    });
    s1(true, { projectId: creds.projectId.slice(0, 8) + '…', secretKeyPrefix: creds.secretKey.slice(0, 4) + '…' });
  } catch (e) {
    s1(false, undefined);
    results[results.length - 1].error = (e as Error).message;
    await reportAndExit();
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 2: Ensure pg is installed, start Docker postgres+pgvector
  // ─────────────────────────────────────────────────────────────────────────
  const s2 = step('Step 2: Start Docker pgvector container');
  let pgConnectionString: string;
  let pgPort: number;

  try {
    // Install pg if needed
    try {
      createRequire(import.meta.url)('pg');
    } catch {
      console.log('[smoke] pg not found — installing...');
      execSync('npm install pg --no-save', { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe' });
    }

    // Pick an ephemeral port (avoid 5432/5433 which may be in use)
    pgPort = 54321;

    // Start Docker container
    const dockerResult = spawnSync(
      'docker',
      [
        'run', '--rm', '-d',
        '-p', `${pgPort}:5432`,
        '-e', 'POSTGRES_PASSWORD=smoke_test',
        '-e', 'POSTGRES_USER=smoke',
        '-e', 'POSTGRES_DB=smoke',
        'pgvector/pgvector:pg16',
      ],
      { encoding: 'utf-8' },
    );
    if (dockerResult.status !== 0) {
      throw new Error(`docker run failed: ${dockerResult.stderr}`);
    }
    dockerContainerId = dockerResult.stdout.trim();
    pgConnectionString = `postgresql://smoke:smoke_test@localhost:${pgPort}/smoke`;

    // Wait for postgres to be ready (max 30s)
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      const check = spawnSync(
        'docker',
        ['exec', dockerContainerId, 'pg_isready', '-U', 'smoke'],
        { encoding: 'utf-8' },
      );
      if (check.status === 0) { ready = true; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!ready) throw new Error('Postgres container did not become ready within 30s');

    s2(true, { port: pgPort, containerId: dockerContainerId.slice(0, 12) });
  } catch (e) {
    s2(false, undefined);
    results[results.length - 1].error = (e as Error).message;
    await cleanup();
    await reportAndExit();
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 3: Install schema (NuVector 1024-dim + NuWiki metadata)
  // ─────────────────────────────────────────────────────────────────────────
  const s3 = step('Step 3: Install 1024-dim pgvector schema + NuWiki metadata schema');
  let memoryAdapter: unknown;
  let metadataAdapter: unknown;
  let bodiesAdapter: unknown;

  try {
    const { NuVectorPostgres } = await import('@nusoft/nuvector/postgres') as {
      NuVectorPostgres: { open: (cfg: { storage: { kind: 'postgres'; connectionString: string }; dimensions: number; tenant: string }) => Promise<unknown> };
    };
    const rawMemory = await NuVectorPostgres.open({
      storage: { kind: 'postgres', connectionString: pgConnectionString },
      dimensions: 1024,
      tenant: 'smoke_wu141',
    });

    // Install NuVector schema
    const nvSchemaFn = (await import('@nusoft/nuvector/postgres') as { buildSchemaSql: (dim: number) => string }).buildSchemaSql;
    const nvSql = nvSchemaFn(1024);
    // Use Pool rather than Client — Pool handles connection lifecycle and
    // avoids the "Calling client.query() when the client is already executing
    // a query" deprecation warning that Client emits in some sequential-query
    // patterns. Pool.end() drains and closes all connections.
    const { Pool } = createRequire(import.meta.url)('pg') as { Pool: new (cfg: { connectionString: string }) => { query(sql: string): Promise<void>; end(): Promise<void> } };
    const schemaPool = new Pool({ connectionString: pgConnectionString });
    await schemaPool.query(nvSql);

    // Install NuWiki metadata schema
    const { buildSchemaSql: nwBuildSchemaSql, NuWikiMetadataPostgres } = await import('../dist/src/postgres.js');
    const nwSql = nwBuildSchemaSql('public');
    await schemaPool.query(nwSql);
    await schemaPool.end();

    // Build NuVector adapter (memory + graph)
    const { createNuVectorAdapter } = await import('../dist/src/nuvector-adapter.js');
    memoryAdapter = await createNuVectorAdapter(rawMemory as Parameters<typeof createNuVectorAdapter>[0]);

    // Build NuWiki metadata adapter (Postgres) — use the static open() factory
    const metaAdapterInstance = await NuWikiMetadataPostgres.open(pgConnectionString, 'public');
    metadataAdapter = metaAdapterInstance;

    // Build in-memory bodies adapter
    const { InMemoryObjectStorageAdapter } = await import('../dist/src/storage.js');
    bodiesAdapter = new InMemoryObjectStorageAdapter();

    s3(true, { nuvectorDimensions: 1024, schema: 'public' });
  } catch (e) {
    s3(false, undefined);
    results[results.length - 1].error = (e as Error).message;
    await cleanup();
    await reportAndExit();
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 4: Open NuWiki + install statutory pack DocumentTypes
  // ─────────────────────────────────────────────────────────────────────────
  const s4 = step('Step 4: Open NuWiki with ScalewayLLMAdapter + load statutory pack');
  let wiki: { seed: Function; list: Function };
  let educationPack: { documentTypes: unknown[]; seedAll: (wiki: unknown, id: string) => Promise<unknown> };

  try {
    const { NuWiki } = await import('../dist/src/index.js');
    const { educationStatutoryPack } = await import('@nusoft/nuwiki-pack-education-statutory');
    educationPack = educationStatutoryPack as typeof educationPack;

    wiki = await NuWiki.open({
      tenant: 'smoke_wu141',
      metadata: metadataAdapter as Parameters<typeof NuWiki.open>[0]['metadata'],
      bodies: bodiesAdapter as Parameters<typeof NuWiki.open>[0]['bodies'],
      memoryAdapter: memoryAdapter as Parameters<typeof NuWiki.open>[0]['memoryAdapter'],
      llmAdapter: adapter as Parameters<typeof NuWiki.open>[0]['llmAdapter'],
      documentTypes: educationStatutoryPack.documentTypes as Parameters<typeof NuWiki.open>[0]['documentTypes'],
    }) as typeof wiki;

    s4(true, {
      documentTypes: educationStatutoryPack.documentTypes.map((dt: unknown) => (dt as { type: string }).type),
    });
  } catch (e) {
    s4(false, undefined);
    results[results.length - 1].error = (e as Error).message;
    await cleanup();
    await reportAndExit();
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 5: Seed all 4 statutory articles (calls wiki.seed() per article)
  // ─────────────────────────────────────────────────────────────────────────
  const s5 = step('Step 5: Seed all 4 statutory articles via pack.seedAll()');
  let seededCount = 0;

  try {
    const seedT0 = Date.now();
    await educationPack.seedAll(wiki, 'inst_smoke_wu141');
    const seedMs = Date.now() - seedT0;

    // Verify all 4 articles landed in metadata
    const articles = await (wiki as { list: Function }).list({ tenant: 'smoke_wu141' });
    seededCount = articles.length;

    if (seededCount !== 4) {
      throw new Error(`Expected 4 articles after seedAll, got ${seededCount}`);
    }

    const articleNames = articles.map((a: { documentType: string }) => a.documentType);
    const expected = [
      'kcsie-dsl-role',
      'restraint-use-of-reasonable-force',
      'exclusions-statutory-guidance',
      'send-cop-ehcp-annual-review',
    ];
    for (const name of expected) {
      if (!articleNames.includes(name)) {
        throw new Error(`Missing expected article: ${name}`);
      }
    }

    s5(true, { articlesSeeded: seededCount, seedDurationMs: seedMs, articles: articleNames });
  } catch (e) {
    s5(false, undefined);
    results[results.length - 1].error = (e as Error).message;
    await cleanup();
    await reportAndExit();
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 6: Semantic retrieval — "restraint reasonable force record-keeping"
  //         must return the Restraint article in top-3
  // ─────────────────────────────────────────────────────────────────────────
  const s6 = step('Step 6: Semantic retrieval — restraint query returns expected article in top-3');

  try {
    const query = 'restraint reasonable force record-keeping';

    // Embed the query using the same adapter
    const queryEmbedding = await adapter.embed(query);

    // Use memoryAdapter.retrieveContext to retrieve top-3 results
    // retrieveContext signature: { embedding, tenant, topK, filters? }
    const contextResult = await (memoryAdapter as {
      retrieveContext: (req: { embedding: Float32Array; tenant: string; topK: number }) => Promise<{ items: Array<{ metadata: Record<string, unknown> }> }>;
    }).retrieveContext({
      embedding: queryEmbedding,
      tenant: 'smoke_wu141',
      topK: 3,
    });

    const items = contextResult?.items ?? [];
    const top3DocTypes = items.map(
      (item) => (item.metadata?.documentType ?? item.metadata?.articleId ?? 'unknown') as string,
    );
    const found = top3DocTypes.some((dt) => typeof dt === 'string' && dt.includes('restraint'));

    if (!found) {
      throw new Error(
        `Retrieval test failed: "restraint-use-of-reasonable-force" not found in top-3. Got: ${JSON.stringify(top3DocTypes)}`,
      );
    }

    s6(true, { query, top3: top3DocTypes, restraintInTop3: true });
  } catch (e) {
    s6(false, undefined);
    results[results.length - 1].error = (e as Error).message;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────────────────────────────────
  await cleanup();
  await reportAndExit();
}

async function reportAndExit() {
  const totalMs = Date.now() - smokeStart;
  const allPass = results.every((r) => r.pass);

  const report = {
    outcome: allPass ? 'PASS' : 'FAIL',
    totalDurationMs: totalMs,
    totalDurationSec: (totalMs / 1000).toFixed(1),
    withinBudget: totalMs < 120_000,
    steps: results,
  };

  console.log('\n' + JSON.stringify(report, null, 2));

  if (!allPass) {
    console.error('\nSMOKE FAILED — see steps above for details');
    process.exit(1);
  } else {
    console.log('\nSMOKE PASSED');
    process.exit(0);
  }
}

main().catch(async (e) => {
  console.error('Unhandled error in smoke harness:', e);
  await cleanup();
  process.exit(1);
});
