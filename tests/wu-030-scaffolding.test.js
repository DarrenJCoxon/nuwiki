/**
 * WU 030 — NuWiki repo scaffolding smoke test.
 *
 * Asserts:
 * - Package builds and exports its public symbols
 * - `NuWiki.open()` works (constructor and tenant plumbing)
 * - Every documented stub method throws a NotImplementedError pointing at
 *   the WU that will implement it
 * - Subpath stubs throw with correct WU pointers
 * - Type surface is reachable (the build artefacts include the .d.ts files
 *   for every type in the contract)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const main = await import('../dist/src/index.js');
const templates = await import('../dist/src/templates.js');
const agentTools = await import('../dist/src/agent-tools.js');
const exportMod = await import('../dist/src/export.js');
const obsidian = await import('../dist/src/obsidian.js');

const { NuWiki, NotImplementedError } = main;

// ---------------------------------------------------------------------------
// § 1  Public surface
// ---------------------------------------------------------------------------

describe('§1 Public surface', () => {
  test('NuWiki class exported', () => {
    assert.equal(typeof NuWiki, 'function');
  });
  test('NotImplementedError exported', () => {
    assert.equal(typeof NotImplementedError, 'function');
    const err = new NotImplementedError('test', 'WU XXX');
    assert.match(err.message, /WU XXX/);
  });
});

// ---------------------------------------------------------------------------
// § 2  NuWiki.open
// ---------------------------------------------------------------------------

describe('§2 NuWiki.open', () => {
  test('returns a NuWiki instance with tenant plumbed through', async () => {
    const wiki = await NuWiki.open({
      metadata: {},
      bodies: {},
      memoryAdapter: {},
      llmAdapter: {},
      tenant: 'school_bridge',
    });
    assert.ok(wiki instanceof NuWiki);
    assert.equal(wiki._getTenant(), 'school_bridge');
  });

  test('throws if tenant is missing', async () => {
    await assert.rejects(
      () =>
        NuWiki.open({
          metadata: {},
          bodies: {},
          memoryAdapter: {},
          llmAdapter: {},
          tenant: '',
        }),
      /requires a tenant/
    );
  });
});

// ---------------------------------------------------------------------------
// § 3  registerDocumentType + listDocumentTypes
// ---------------------------------------------------------------------------

describe('§3 DocumentType registry', () => {
  test('registerDocumentType + listDocumentTypes', async () => {
    const wiki = await NuWiki.open({
      metadata: {}, bodies: {}, memoryAdapter: {}, llmAdapter: {},
      tenant: 'test',
    });
    wiki.registerDocumentType({
      type: 'pupil_profile',
      version: '1.0.0',
      subjectKind: 'pupil',
      description: 'Per-pupil current state',
      sections: [],
      sourceQueries: [],
      refreshTriggers: [],
      visibility: { defaultRoles: ['teacher'] },
      retentionPolicy: { archiveOnSubjectExit: true, legalHoldHonoured: true },
      precisionIndexable: false,
      retrievalHints: {
        summaryTokenBudget: 200,
        primaryQueryUseCases: ['morning briefing'],
        sectionsPriorityForSummary: [],
        embedSectionsWithSummaryPrefix: true,
      },
    });
    const types = wiki.listDocumentTypes();
    assert.equal(types.length, 1);
    assert.equal(types[0].type, 'pupil_profile');
  });

  test('duplicate registration throws', async () => {
    const wiki = await NuWiki.open({
      metadata: {}, bodies: {}, memoryAdapter: {}, llmAdapter: {},
      tenant: 'test',
    });
    const dt = {
      type: 'duplicate', version: '1.0.0', subjectKind: 'pupil',
      description: '', sections: [], sourceQueries: [], refreshTriggers: [],
      visibility: { defaultRoles: [] },
      retentionPolicy: { archiveOnSubjectExit: false, legalHoldHonoured: false },
      precisionIndexable: false,
      retrievalHints: { summaryTokenBudget: 100, primaryQueryUseCases: [], sectionsPriorityForSummary: [], embedSectionsWithSummaryPrefix: true },
    };
    wiki.registerDocumentType(dt);
    assert.throws(() => wiki.registerDocumentType(dt), /already registered/);
  });
});

// ---------------------------------------------------------------------------
// § 4  Methods still pending implementation throw NotImplementedError
//
// WU 036 implemented compile / refresh / list / archive / delete /
// affectedDocuments. The remaining stubs assert the post-WU-036 state.
// ---------------------------------------------------------------------------

describe('§4 Pending-WU stubs throw with WU pointers', () => {
  let wiki;
  test('setup', async () => {
    wiki = await NuWiki.open({
      metadata: {}, bodies: {}, memoryAdapter: {}, llmAdapter: {},
      tenant: 'test',
    });
  });

  const cases = [
    { method: 'read', args: [{}], wu: /WU 041/ },
    { method: 'followLinks', args: [{}], wu: /WU 040/ },
    { method: 'runIntegrityPass', args: [{}], wu: /WU 042/ },
    { method: 'suggestNewArticles', args: [{}], wu: /WU 043/ },
    { method: 'export', args: ['id', 'pdf'], wu: /post-v0\.1\.0/ },
  ];

  for (const c of cases) {
    test(`${c.method} throws NotImplementedError pointing at ${c.wu}`, async () => {
      await assert.rejects(() => wiki[c.method](...c.args), c.wu);
    });
  }

  test('compile / refresh / list / archive / delete / affectedDocuments are functions (implemented at WU 036)', () => {
    for (const m of ['compile', 'refresh', 'list', 'archive', 'delete', 'affectedDocuments']) {
      assert.equal(typeof wiki[m], 'function', `expected ${m} to be a function`);
    }
  });
});

// ---------------------------------------------------------------------------
// § 5  Subpath stubs
// ---------------------------------------------------------------------------

describe('§5 Subpath stubs throw with helpful messages', () => {
  test('NuWikiTemplates.education throws pointing at WU 044', () => {
    assert.throws(() => templates.NuWikiTemplates.education, /WU 044/);
  });

  test('NuWikiAgentTools.cite throws pointing at post-v0.1.0', () => {
    assert.throws(() => agentTools.NuWikiAgentTools.cite(), /post-v0\.1\.0/);
  });

  test('NuWikiExport.toPdf throws pointing at post-v0.1.0', () => {
    assert.throws(() => exportMod.NuWikiExport.toPdf(), /post-v0\.1\.0/);
  });

  test('NuWikiObsidian.exportVault throws pointing at post-v0.1.0', () => {
    assert.throws(() => obsidian.NuWikiObsidian.exportVault(), /post-v0\.1\.0/);
  });
});

// ---------------------------------------------------------------------------
// § 6  Type surface reachability
// ---------------------------------------------------------------------------

describe('§6 Type surface reachability', () => {
  test('main module exports the expected symbols', () => {
    // A small sample of types/symbols that should be re-exported via index.ts
    const expectedNamed = ['NuWiki', 'NotImplementedError'];
    for (const symbol of expectedNamed) {
      assert.ok(symbol in main, `missing: ${symbol}`);
    }
  });
});

console.log('\nWU 030 — NuWiki scaffolding smoke test complete\n');
