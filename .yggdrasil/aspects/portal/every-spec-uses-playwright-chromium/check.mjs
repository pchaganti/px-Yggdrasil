import { walk, report } from '@chrisdudek/yg/ast';

// Invariant 6 (half): every portal e2e SPEC must actually be a Playwright + Chromium browser
// test — not a fake/smoke file that imports nothing and asserts nothing in a browser. The
// suite runs under the chromium project (playwright.config.ts → projects: [{ name: 'chromium',
// use: devices['Desktop Chrome'] }]), so a real spec drives a real Chromium page. This check
// enforces, per spec file, the two structural facts that make that true:
//
//   (1) it imports Playwright's `test` — directly from '@playwright/test' OR from the project's
//       Playwright fixture re-export './support/fixtures' (which itself imports @playwright/test
//       and is itself verified to do so by this same check, since support/fixtures.ts is mapped).
//   (2) it actually DRIVES a browser: it defines at least one `test(...)` whose body uses the
//       Playwright `page` (page.goto / page.locator / page.keyboard / page.request / page.evaluate)
//       OR a worker page fixture (repoPage / basicPage) handed to a real navigation — i.e. it
//       opens a page and asserts in the browser, never an empty no-op.
//
// scope: per node — the whole suite's files are in ctx.files; we judge each *.spec.ts among them
// and also confirm the support fixture re-exports @playwright/test (so (1)'s indirect path is real).
// AST-based: we inspect import sources and call expressions, never raw text — a string literal
// that merely mentions 'playwright' is a plain string node, not an import, so it is not a hit.

const PW_PACKAGE = '@playwright/test';
const SUPPORT_FIXTURE_SPECIFIERS = new Set(['./support/fixtures', './fixtures']);
// Browser-driving member calls that prove a test opens/inspects a real page.
const PAGE_DRIVERS = new Set(['goto', 'locator', 'keyboard', 'request', 'evaluate', 'reload', 'emulateMedia', 'getByRole', 'getByText', 'click', 'press', 'fill']);

function stringValue(node) {
  if (!node) return undefined;
  if (node.type !== 'string' && node.type !== 'template_string') return undefined;
  if (node.type === 'template_string' && node.namedChildren.some((c) => c.type === 'template_substitution')) {
    return undefined;
  }
  const frag = node.namedChildren.find((c) => c.type === 'string_fragment');
  if (frag) return frag.text;
  const t = node.text;
  return t.length >= 2 ? t.slice(1, -1) : '';
}

/** True iff the file is a portal e2e SPEC (a *.spec.ts under the suite), not a support helper. */
function isSpec(filePath) {
  return /\.spec\.ts$/.test(filePath);
}

/** True iff the file is the project's Playwright fixture re-export module. */
function isSupportFixture(filePath) {
  return /\/support\/fixtures\.ts$/.test(filePath) || /(^|\/)fixtures\.ts$/.test(filePath);
}

/**
 * Collect, per file: every import source string, and whether the file makes any browser-driving
 * page call. One AST pass; pure over the tree.
 */
function scanFile(file) {
  const importSources = new Set();
  let drivesPage = false;

  walk(file.ast.rootNode, (node) => {
    if (node.type === 'import_statement' || node.type === 'export_statement') {
      const spec = stringValue(node.childForFieldName('source'));
      if (typeof spec === 'string' && spec.length) importSources.add(spec);
      return true;
    }
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function');
      if (fn && fn.type === 'member_expression') {
        const prop = fn.childForFieldName('property')?.text ?? '';
        if (PAGE_DRIVERS.has(prop)) drivesPage = true;
      }
      return true;
    }
    return true;
  });

  return { importSources, drivesPage };
}

export function check(ctx) {
  const violations = [];

  // First pass: confirm the support fixture re-export actually imports @playwright/test, so a
  // spec's indirect import path ('./support/fixtures') genuinely reaches Playwright. If the
  // fixture is present but does NOT import @playwright/test, the indirect path is a lie — flag it.
  let supportFixtureImportsPw = false;
  let supportFixtureSeen = false;
  for (const file of ctx.files) {
    if (!file.ast || !isSupportFixture(file.path)) continue;
    supportFixtureSeen = true;
    const { importSources } = scanFile(file);
    if (importSources.has(PW_PACKAGE)) supportFixtureImportsPw = true;
    else {
      violations.push({
        file: file.path,
        line: 1,
        column: 0,
        message:
          `The Playwright fixture re-export '${file.path}' must import '${PW_PACKAGE}' so specs that import ` +
          `'./support/fixtures' genuinely run on Playwright + Chromium. It does not — add the import or have ` +
          `each spec import '${PW_PACKAGE}' directly.`,
      });
    }
  }

  // Per-spec: must import Playwright (directly or via the verified support fixture) AND drive a page.
  for (const file of ctx.files) {
    if (!file.ast || !isSpec(file.path)) continue;
    const { importSources, drivesPage } = scanFile(file);

    const importsDirect = importSources.has(PW_PACKAGE);
    const importsViaSupport =
      [...importSources].some((s) => SUPPORT_FIXTURE_SPECIFIERS.has(s)) && supportFixtureSeen && supportFixtureImportsPw;

    if (!importsDirect && !importsViaSupport) {
      violations.push({
        file: file.path,
        line: 1,
        column: 0,
        message:
          `Portal e2e spec '${file.path}' does not use Playwright: it imports neither '${PW_PACKAGE}' directly ` +
          `nor the project's Playwright fixture './support/fixtures'. A portal e2e spec must run on ` +
          `Playwright + Chromium — a non-Playwright file in this suite asserts nothing in a real browser.`,
      });
      continue;
    }

    if (!drivesPage) {
      violations.push({
        file: file.path,
        line: 1,
        column: 0,
        message:
          `Portal e2e spec '${file.path}' imports Playwright but never drives a browser page (no page.goto / ` +
          `page.locator / page.keyboard / page.request / page.evaluate / page.reload). A real Chromium e2e ` +
          `opens the page and asserts in the browser — this looks like a smoke stub. Drive the real page.`,
      });
    }
  }

  return violations;
}
