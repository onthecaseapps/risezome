#!/usr/bin/env node
/**
 * check-service-role-org-scope.mjs
 * ================================
 *
 * Static CI guard for cross-org defense-in-depth (security plan U2, R6).
 *
 * WHAT IT FLAGS
 * -------------
 * Any *service-role* (RLS-bypassing) Supabase query issued against an
 * *org-scoped table* (a table that has an `org_id` column) whose fluent
 * `.from(...)` chain does not carry an `org_id` predicate — unless the call
 * site is annotated as a deliberate cross-org job.
 *
 * The bot-worker's db.ts has long promised this guard ("the cross-org grep
 * check that lands later"); this is that guard, now real.
 *
 * HOW THE ORG-SCOPED TABLE SET IS DERIVED
 * ---------------------------------------
 * Self-maintaining: we scan supabase/migrations/*.sql for `create table`
 * blocks (and `alter table ... add column ... org_id`) and collect every
 * table that declares an `org_id` column. Tables without org_id (e.g.
 * `orgs` itself which keys on `id`, `user_google_tokens`, `meeting_participants`)
 * are intentionally NOT in the set, so queries on them are ignored. Add a
 * new org-scoped table via a migration and the guard picks it up for free.
 *
 * HOW SERVICE-ROLE QUERIES ARE IDENTIFIED
 * ---------------------------------------
 * Two complementary mechanisms (a query is "service-role" if EITHER matches):
 *
 *  1. Per-file root-identifier resolution. We collect identifiers bound to a
 *     service-role client in the same file: a `const x = createServiceClient()`
 *     / `createServiceRoleClient()` / `createClient(url, SUPABASE_SECRET_KEY...)`
 *     (or `SUPABASE_SERVICE_ROLE_KEY`). A `.from(...)` chain whose root
 *     identifier is one of those names is a service-role query. The
 *     authenticated, RLS-respecting client (`createServerClient` from
 *     apps/portal/app/_lib/supabase-server.ts) is deliberately NOT matched and
 *     is never flagged.
 *
 *  2. Service-role modules. In a couple of files the service client arrives as
 *     a function PARAMETER (named `client` / `db`, threaded as `args.db`), so
 *     per-file root resolution cannot classify it. For the explicit set in
 *     SERVICE_ROLE_MODULES (apps/bot-worker/src/db.ts and
 *     apps/bot-worker/src/retrieval.ts) we treat the whole file as a
 *     service-role context: EVERY org-scoped `.from(...)` chain is checked
 *     regardless of root identifier.
 *
 * CHAIN ANALYSIS
 * --------------
 * Parsing uses the TypeScript compiler API (not line regex). For each
 * `.from(table)` call we walk the enclosing fluent method chain and collect
 * the predicate-key of every `.eq` / `.in` / `.match` / `.filter` / `.or` /
 * `.contains` call. The chain is "scoped" when any of those references
 * `org_id`:
 *   - `.eq('org_id', ...)` / `.in('org_id', ...)` / `.contains('org_id', ...)`
 *     — first string-literal arg equals `org_id`.
 *   - `.match({ org_id: ... })` — object literal with an `org_id` key.
 *   - `.or("...org_id...")` / `.filter("...org_id...")` — string contains org_id.
 *   - `.insert({...org_id...})` / `.upsert({...org_id...})` — a write whose row
 *     value object (or array of row objects) carries org_id is org-bound by the
 *     payload itself; it cannot land in another org's partition.
 * Scoped OR annotated => OK; otherwise => violation.
 *
 * ALLOWLIST ANNOTATION
 * --------------------
 * A genuine cross-org background job (Inngest indexer, reconcile sweep, purge)
 * exempts a chain with a comment of the exact form:
 *
 *     // service-role-cross-org: <reason>
 *
 * placed ON the statement line or on a line directly above the statement that
 * contains the `.from(...)` call. The annotation applies to that one statement.
 *
 * EXIT CODES
 * ----------
 *   0 = clean, 1 = violations (each printed as `path:line: <message>`).
 *
 * RUN
 * ---
 *   node scripts/lint/check-service-role-org-scope.mjs
 *
 * The repo root is normally derived from this script's location. Tests can
 * override it (to point at a throwaway fixture tree) via the
 * CHECK_ORG_SCOPE_ROOT env var, which keeps `typescript` resolvable from the
 * real install while scanning fixture files elsewhere.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env['CHECK_ORG_SCOPE_ROOT']
  ? resolve(process.env['CHECK_ORG_SCOPE_ROOT'])
  : join(__dirname, '..', '..');

const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations');

// Directories scanned for source files.
const SCAN_DIRS = [
  join(REPO_ROOT, 'apps', 'bot-worker', 'src'),
  join(REPO_ROOT, 'apps', 'portal', 'app'),
  join(REPO_ROOT, 'apps', 'portal', 'src'),
];

// Files where the service client arrives as a parameter; treat the whole file
// as a service-role context (check every org-scoped .from chain).
const SERVICE_ROLE_MODULES = new Set([
  join(REPO_ROOT, 'apps', 'bot-worker', 'src', 'db.ts'),
  join(REPO_ROOT, 'apps', 'bot-worker', 'src', 'retrieval.ts'),
]);

// Per-(file, table) exemptions for service-role reads that are legitimately
// scoped by a non-org key (the signed-in user's own user_id) and are tracked as
// authenticated-client migration candidates in plan U5. Keyed by repo-relative
// path. Prefer an inline `// service-role-cross-org: <reason>` annotation at the
// call site; this map exists only for the per-user `lookupLastSyncedAt`
// calendar_events read in upcoming/page.tsx, which is under active unrelated WIP
// and must not be edited here (the file's main calendar_events query is already
// org-scoped, so this exemption does not weaken that check). Remove the entry
// when U5 moves that read onto the authenticated client.
const PATH_TABLE_ALLOWLIST = new Map([
  ['apps/portal/app/(authed)/upcoming/page.tsx', new Set(['calendar_events'])],
]);

// Factory calls that produce a service-role client.
const SERVICE_FACTORY_NAMES = new Set(['createServiceClient', 'createServiceRoleClient']);
// Env vars that mark a raw createClient(...) as service-role.
const SERVICE_ENV_MARKERS = ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
// Factory calls that produce the AUTHENTICATED, RLS-respecting client. A chain
// rooted on one of these is never a service-role query — even inside a file that
// also uses a service-role client (so whole-file service-role context must not
// flag these). RLS already scopes them to the caller's org.
const AUTH_FACTORY_NAMES = new Set(['createServerClient']);

// Predicate methods whose first string-literal arg names a column.
const COLUMN_PREDICATE_METHODS = new Set(['eq', 'in', 'contains']);
// Predicate methods that take a raw filter string possibly containing org_id.
const STRING_PREDICATE_METHODS = new Set(['or', 'filter']);
// Write methods whose row-value object(s) carry the column => value mapping.
const VALUE_WRITE_METHODS = new Set(['insert', 'upsert']);
// .match takes an object literal of column => value.
const ANNOTATION_RE = /\/\/\s*service-role-cross-org:/;

/**
 * Derive the set of org-scoped table names from the SQL migrations.
 * @returns {Set<string>}
 */
function deriveOrgScopedTables() {
  const orgTables = new Set();
  if (!existsSync(MIGRATIONS_DIR)) return orgTables;
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    // Strip line comments so a `-- ... org_id ...` note never counts.
    const clean = sql.replace(/--[^\n]*/g, '');

    // create table [if not exists] [public.]<name> ( ...body... )
    const createRe =
      /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi;
    let m;
    while ((m = createRe.exec(clean)) !== null) {
      const name = m[1];
      // Walk to the matching close paren to isolate the column block.
      let depth = 0;
      let i = m.index + m[0].length - 1; // at the opening '('
      const start = i;
      for (; i < clean.length; i++) {
        if (clean[i] === '(') depth++;
        else if (clean[i] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      const body = clean.slice(start + 1, i);
      // org_id as a column name at the start of a column definition.
      if (/(^|,)\s*org_id\b/i.test(body)) orgTables.add(name);
    }

    // alter table [public.]<name> add column [if not exists] org_id ...
    const alterRe =
      /alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?org_id\b/gi;
    while ((m = alterRe.exec(clean)) !== null) {
      orgTables.add(m[1]);
    }
  }
  return orgTables;
}

/** Recursively collect .ts/.tsx files under a directory. */
function collectSourceFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build')
        continue;
      out.push(...collectSourceFiles(full));
    } else if (
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test.tsx')
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Does this createClient(...) call reference a service-role env marker? */
function createClientIsServiceRole(callExpr, sourceText) {
  // Cheap + robust: check the call's source text for the env marker.
  const callText = sourceText.slice(callExpr.getStart(), callExpr.getEnd());
  return SERVICE_ENV_MARKERS.some((marker) => callText.includes(marker));
}

/**
 * Does this file import or require a service-role client factory
 * (createServiceRoleClient / createServiceClient)? If so the whole file is a
 * service-role context: the client may arrive as a renamed parameter, be called
 * inline, or be re-wrapped, none of which per-identifier resolution catches. We
 * still verify every org-scoped `.from` carries an org_id predicate, which is a
 * pure tightening (it can only ADD checks, never remove the createServerClient
 * exclusion — that authenticated client is a different import).
 * @returns {boolean}
 */
function fileImportsServiceFactory(sourceFile) {
  let found = false;
  function visit(node) {
    if (found) return;
    // import { createServiceRoleClient, ... } from '...'
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings) {
      const nb = node.importClause.namedBindings;
      if (ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          // Match the IMPORTED name (el.propertyName when aliased, else el.name)
          // so `import { createServiceRoleClient as c }` still counts.
          const imported = (el.propertyName ?? el.name).text;
          if (SERVICE_FACTORY_NAMES.has(imported)) {
            found = true;
            return;
          }
        }
      }
    }
    // const { createServiceRoleClient } = require('...')  /  = await import('...')
    if (ts.isVariableDeclaration(node) && node.name && ts.isObjectBindingPattern(node.name)) {
      for (const el of node.name.elements) {
        const imported = el.propertyName ?? el.name;
        if (imported && ts.isIdentifier(imported) && SERVICE_FACTORY_NAMES.has(imported.text)) {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

/**
 * Collect identifier names bound to a service-role client in a source file.
 * @returns {Set<string>}
 */
function collectServiceRoleIdentifiers(sourceFile, sourceText) {
  const names = new Set();

  function initIsServiceRole(init) {
    if (init === undefined || init === null) return false;
    // Unwrap `await <call>`
    if (ts.isAwaitExpression(init)) return initIsServiceRole(init.expression);
    if (!ts.isCallExpression(init)) return false;
    const callee = init.expression;
    let calleeName;
    if (ts.isIdentifier(callee)) calleeName = callee.text;
    else if (ts.isPropertyAccessExpression(callee)) calleeName = callee.name.text;
    if (calleeName === undefined) return false;
    if (SERVICE_FACTORY_NAMES.has(calleeName)) return true;
    if (calleeName === 'createClient') return createClientIsServiceRole(init, sourceText);
    return false;
  }

  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      if (initIsServiceRole(node.initializer) && ts.isIdentifier(node.name)) {
        names.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return names;
}

/**
 * Collect identifier names bound to the AUTHENTICATED (RLS-respecting) client in
 * a file: `const x = await createServerClient()`. Used to EXCLUDE such chains
 * from whole-file service-role context (a file may use both clients).
 * @returns {Set<string>}
 */
function collectAuthClientIdentifiers(sourceFile) {
  const names = new Set();
  function initIsAuth(init) {
    if (init === undefined || init === null) return false;
    if (ts.isAwaitExpression(init)) return initIsAuth(init.expression);
    if (!ts.isCallExpression(init)) return false;
    const callee = init.expression;
    let calleeName;
    if (ts.isIdentifier(callee)) calleeName = callee.text;
    else if (ts.isPropertyAccessExpression(callee)) calleeName = callee.name.text;
    return calleeName !== undefined && AUTH_FACTORY_NAMES.has(calleeName);
  }
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      initIsAuth(node.initializer) &&
      ts.isIdentifier(node.name)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return names;
}

/** Does an object literal have an `org_id` property (assignment or shorthand)? */
function objectLiteralHasOrgId(obj) {
  if (!ts.isObjectLiteralExpression(obj)) return false;
  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) {
      // `{ ...row }` — the spread may carry org_id; we can't see it statically,
      // so conservatively treat a spread as possibly-org-bound to avoid noise.
      return true;
    }
    if (
      (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
      prop.name &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) &&
      prop.name.text === 'org_id'
    ) {
      return true;
    }
  }
  return false;
}

/** insert/upsert arg: object literal, or array of object literals, with org_id. */
function objectOrArrayHasOrgId(arg) {
  if (arg === undefined) return false;
  if (ts.isObjectLiteralExpression(arg)) return objectLiteralHasOrgId(arg);
  if (ts.isArrayLiteralExpression(arg)) {
    // Scoped only if every element object carries org_id; a single unscoped
    // element would be a cross-org write. Empty/spread arrays are treated as
    // org-bound (we cannot see into a variable) to avoid false positives.
    let sawObject = false;
    for (const el of arg.elements) {
      if (ts.isObjectLiteralExpression(el)) {
        sawObject = true;
        if (!objectLiteralHasOrgId(el)) return false;
      } else if (ts.isSpreadElement(el)) {
        return true; // opaque
      }
    }
    return sawObject;
  }
  // A non-literal arg (variable / function call building rows) is opaque; we
  // cannot statically verify org_id, so do not flag it (avoid false positives).
  return true;
}

/**
 * Walk a fluent builder chain to find the .from(table) call and gather every
 * predicate. Given a CallExpression node `.from(...)`, returns the chain root
 * identifier name and a "scoped" boolean.
 *
 * We locate the outermost chain expression containing this .from call, then
 * traverse all PropertyAccess/Call links to collect predicates anywhere in the
 * chain (both before and after .from).
 */
function analyzeFromCall(fromCall, sourceFile, sourceText) {
  // Find the topmost expression statement / expression that this chain belongs
  // to by climbing parents while we stay within a call/property-access chain.
  let top = fromCall;
  while (
    top.parent &&
    (ts.isPropertyAccessExpression(top.parent) ||
      ts.isCallExpression(top.parent) ||
      ts.isAwaitExpression(top.parent) ||
      ts.isNonNullExpression(top.parent) ||
      ts.isParenthesizedExpression(top.parent))
  ) {
    top = top.parent;
  }

  // Root identifier: descend the leftmost expression of the chain that ends in
  // .from(...). The object of .from's property access is the chain prefix.
  // `rootIsServiceCall` is set when the chain root is a DIRECT call to a service
  // factory (e.g. `createServiceRoleClient().from(...)`) or a `createClient(...)`
  // carrying a service env marker — an inline pattern that has no bound
  // identifier to resolve, so without this it would be silently exempt.
  let rootName;
  let rootIsServiceCall = false;
  {
    // fromCall.expression is a PropertyAccessExpression `<obj>.from`
    let obj = ts.isPropertyAccessExpression(fromCall.expression)
      ? fromCall.expression.expression
      : undefined;
    // Walk down to the leftmost identifier.
    while (obj !== undefined) {
      if (ts.isIdentifier(obj)) {
        rootName = obj.text;
        break;
      }
      if (ts.isPropertyAccessExpression(obj)) {
        // e.g. args.db.from(...) -> leftmost identifier is `args`, but the
        // meaningful binding is the full `args.db`. We capture the leftmost id
        // for root-name matching, plus expose the property name.
        obj = obj.expression;
      } else if (ts.isCallExpression(obj)) {
        // A call in the chain root: if it directly invokes a service factory (or
        // createClient with a service marker) the chain is service-role even with
        // no bound identifier. Check before descending into its callee.
        const callee = obj.expression;
        let calleeName;
        if (ts.isIdentifier(callee)) calleeName = callee.text;
        else if (ts.isPropertyAccessExpression(callee)) calleeName = callee.name.text;
        if (calleeName !== undefined && SERVICE_FACTORY_NAMES.has(calleeName)) {
          rootIsServiceCall = true;
        } else if (calleeName === 'createClient' && createClientIsServiceRole(obj, sourceText)) {
          rootIsServiceCall = true;
        }
        obj = obj.expression;
      } else if (
        ts.isAwaitExpression(obj) ||
        ts.isParenthesizedExpression(obj) ||
        ts.isNonNullExpression(obj)
      ) {
        obj = obj.expression;
      } else {
        break;
      }
    }
  }

  // Collect predicate method calls within the chain `top`.
  let scoped = false;
  function collectPredicates(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const args = node.arguments;
      if (COLUMN_PREDICATE_METHODS.has(method) && args.length >= 1) {
        const a0 = args[0];
        if (ts.isStringLiteralLike(a0) && a0.text === 'org_id') scoped = true;
      } else if (method === 'match' && args.length >= 1) {
        const a0 = args[0];
        if (ts.isObjectLiteralExpression(a0)) {
          for (const prop of a0.properties) {
            if (
              (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
              prop.name &&
              (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) &&
              prop.name.text === 'org_id'
            ) {
              scoped = true;
            }
          }
        }
      } else if (STRING_PREDICATE_METHODS.has(method) && args.length >= 1) {
        const a0 = args[0];
        if (ts.isStringLiteralLike(a0) && a0.text.includes('org_id')) scoped = true;
      } else if (VALUE_WRITE_METHODS.has(method) && args.length >= 1) {
        // .insert(row) / .insert([rows]) / .upsert(row): a row-value object
        // carrying org_id is org-bound by its own payload.
        if (objectOrArrayHasOrgId(args[0])) scoped = true;
      }
    }
    ts.forEachChild(node, collectPredicates);
  }
  collectPredicates(top);

  return { rootName, scoped, top, rootIsServiceCall };
}

/** True if the statement containing `node` (or the line above) is annotated. */
function isAnnotated(node, sourceFile, sourceText, lines) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  // line is 0-based. Check this line and the line above.
  if (lines[line] !== undefined && ANNOTATION_RE.test(lines[line])) return true;
  if (line > 0 && lines[line - 1] !== undefined && ANNOTATION_RE.test(lines[line - 1])) return true;
  // Also check leading comment ranges attached to the enclosing statement.
  let stmt = node;
  while (stmt.parent && !ts.isStatement(stmt)) stmt = stmt.parent;
  const ranges = ts.getLeadingCommentRanges(sourceText, stmt.getFullStart()) ?? [];
  for (const r of ranges) {
    if (ANNOTATION_RE.test(sourceText.slice(r.pos, r.end))) return true;
  }
  return false;
}

function main() {
  const orgTables = deriveOrgScopedTables();
  const violations = [];

  const files = [];
  for (const dir of SCAN_DIRS) files.push(...collectSourceFiles(dir));

  for (const file of files) {
    const sourceText = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const lines = sourceText.split('\n');
    // A file is a service-role context if it is in the explicit fallback list OR
    // it imports/requires a service-role client factory (catches renamed-param
    // helpers a hardcoded list would miss).
    const isServiceModule = SERVICE_ROLE_MODULES.has(file) || fileImportsServiceFactory(sourceFile);
    const serviceIdents = collectServiceRoleIdentifiers(sourceFile, sourceText);
    const authIdents = collectAuthClientIdentifiers(sourceFile);

    // Visit every .from(<literal>) call.
    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'from' &&
        node.arguments.length >= 1 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        const table = node.arguments[0].text;
        if (orgTables.has(table)) {
          const { rootName, scoped, rootIsServiceCall } = analyzeFromCall(
            node,
            sourceFile,
            sourceText,
          );
          // A chain rooted on the authenticated RLS client is never service-role,
          // even in a whole-file service-role context (the file may use both).
          const rootIsAuthClient = rootName !== undefined && authIdents.has(rootName);
          const isServiceRoleQuery =
            !rootIsAuthClient &&
            (isServiceModule ||
              rootIsServiceCall ||
              (rootName !== undefined && serviceIdents.has(rootName)));
          const relPath = relative(REPO_ROOT, file);
          const pathAllowed = PATH_TABLE_ALLOWLIST.get(relPath)?.has(table) === true;
          if (isServiceRoleQuery && !scoped && !pathAllowed) {
            if (!isAnnotated(node, sourceFile, sourceText, lines)) {
              const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              violations.push({
                file,
                line: line + 1,
                table,
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }

  if (violations.length > 0) {
    for (const v of violations) {
      const rel = relative(REPO_ROOT, v.file);
      console.error(
        `${rel}:${v.line}: service-role query on org-scoped table '${v.table}' is missing an org_id predicate ` +
          `(add .eq('org_id', ...) or annotate the statement with // service-role-cross-org: <reason>)`,
      );
    }
    console.error(`\n${violations.length} cross-org scoping violation(s) found.`);
    process.exit(1);
  }

  console.log(
    `check-service-role-org-scope: OK — ${orgTables.size} org-scoped tables, ${files.length} files scanned, 0 violations.`,
  );
  process.exit(0);
}

main();
