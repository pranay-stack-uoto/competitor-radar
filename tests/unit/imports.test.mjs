// A name used in a source file must be defined or imported there. Next's build and the unit tests do not catch a missing import in code that only
// runs inside the worker, and a try/catch around it can hide the ReferenceError entirely (this happened: the daily crawl, the audit and the
// industry snapshot all failed in production for that reason). This check is deliberately simple: it looks for the names the project's own
// modules export (long, camelCase names only, to avoid false alarms) and requires an import or a local definition wherever one is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? (f === 'node_modules' ? [] : walk(p)) : [p]; });
const files = [...walk(path.join(ROOT, 'lib')), ...walk(path.join(ROOT, 'app'))].filter((f) => /\.(js|jsx)$/.test(f));
const src = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
const stripComments = (c) => c.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

// Names each local module exports.
const exported = new Map(); // name -> Set(files)
for (const [f, code] of src) {
  const names = new Set();
  for (const m of code.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of code.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const n of m[1].split(',')) names.add(n.trim().split(/\s+as\s+/).pop());
  const cjs = code.match(/module\.exports\s*=\s*\{([\s\S]*?)\}\s*;?\s*$/m);
  if (cjs) for (const n of cjs[1].split(',')) { const k = n.trim().split(':')[0].trim(); if (/^[A-Za-z_$][\w$]*$/.test(k)) names.add(k); }
  for (const n of names) if (n.length >= 7 && /[a-z][A-Z]/.test(n)) { if (!exported.has(n)) exported.set(n, new Set()); exported.get(n).add(f); }
}

test('every project-defined function used in a file is imported or defined there', () => {
  assert.ok(exported.size > 40, `found ${exported.size} exported names`);
  const problems = [];
  for (const [f, raw] of src) {
    const code = stripComments(raw);
    for (const [name, definedIn] of exported) {
      if (definedIn.size === 1 && definedIn.has(f)) continue;
      const used = new RegExp(`(?<![\\w$.'"])${name.replace(/\$/g, '\\$')}\\s*\\(`).test(code);
      if (!used) continue;
      const imported = new RegExp(`import[^;]*\\b${name}\\b[^;]*from`).test(raw) || new RegExp(`(?:const|let|var)\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=\\s*(?:require|await import)`).test(raw);
      const local = new RegExp(`(?:function\\*?\\s+|const\\s+|let\\s+|var\\s+)${name}\\b`).test(raw) || new RegExp(`[(,]\\s*${name}\\s*[,)=]`).test(raw.split('\n').filter((l) => /=>|function/.test(l)).join('\n'));
      if (!imported && !local) problems.push(`${path.relative(ROOT, f)} uses ${name}()`);
    }
  }
  assert.deepEqual(problems, []);
});
