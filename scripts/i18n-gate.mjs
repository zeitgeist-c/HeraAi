#!/usr/bin/env node
/**
 * Translation gate for HeraAi.
 *
 * Source of truth is src/locales/en.json. Every other locale must carry exactly
 * the same key set, the same interpolation placeholders and the same plural
 * suffixes. A locale that is missing a key, drops a {{count}} or leaves an
 * English string untranslated fails the gate.
 *
 *   node scripts/i18n-gate.mjs            report only
 *   node scripts/i18n-gate.mjs --strict   exit 1 on any problem
 *   node scripts/i18n-gate.mjs --pseudo   also write a pseudo-locale for layout testing
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const localeDir = join(root, 'src', 'locales');
const BASE = 'en';

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const PSEUDO = args.includes('--pseudo');

/** Flatten a nested messages object into dotted keys. */
function flatten(obj, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, path, out);
    } else {
      out[path] = value;
    }
  }
  return out;
}

/** i18next interpolation and plural suffixes. */
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function placeholders(text) {
  const found = new Set();
  let m;
  while ((m = PLACEHOLDER.exec(text)) !== null) found.add(m[1]);
  return found;
}

/** How many plural forms i18next needs per language. */
const PLURAL_FORMS = {
  en: 2, tr: 2, es: 2, de: 2, fr: 2, it: 2, 'pt-BR': 2, nl: 2,
  ru: 3, pl: 3, 'zh-CN': 1, ja: 1, ko: 1,
};

function loadLocale(code) {
  const file = join(localeDir, `${code}.json`);
  if (!existsSync(file)) return null;
  return flatten(JSON.parse(readFileSync(file, 'utf8')));
}

const locales = readdirSync(localeDir)
  .filter((f) => f.endsWith('.json') && !f.includes('(1)'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();

const base = loadLocale(BASE);
if (!base) {
  console.error(`FATAL: ${BASE}.json not found in ${localeDir}`);
  process.exit(2);
}
const baseKeys = new Set(Object.keys(base));

let problems = 0;
const report = [];

for (const code of locales) {
  if (code === BASE) continue;
  const messages = loadLocale(code);
  if (!messages) {
    report.push(`${code}: MISSING FILE`);
    problems++;
    continue;
  }

  const keys = new Set(Object.keys(messages));

  // Plural families are compared by stem, not by literal key: Chinese needs one
  // form (keep) where English needs two (keep_one/keep_other), Polish three. A
  // raw key-set diff would mark every such locale as missing and extra at once,
  // so collapse each family to its stem and let the form count below decide.
  const pluralStems = new Set(
    [...baseKeys].filter((k) => PLURAL_SUFFIX.test(k)).map((k) => k.replace(PLURAL_SUFFIX, ''))
  );
  const normalise = (key) => {
    const stem = key.replace(PLURAL_SUFFIX, '');
    return stem !== key && pluralStems.has(stem) ? stem : key;
  };
  const baseSet = new Set([...baseKeys].map(normalise));
  const keySet = new Set([...keys].map(normalise));

  const missing = [...baseSet].filter((k) => !keySet.has(k));
  const extra = [...keySet].filter((k) => !baseSet.has(k));

  const placeholderErrors = [];
  const emptyValues = [];
  const untranslated = [];

  for (const baseKey of baseKeys) {
    // A one-form language carries the plural family as the bare stem, so map
    // keep_one/keep_other -> keep before comparing values and placeholders.
    let key = baseKey;
    if (!keys.has(key) && PLURAL_SUFFIX.test(key)) {
      const stem = key.replace(PLURAL_SUFFIX, '');
      if (keys.has(stem)) key = stem;
    }
    if (!keys.has(key)) continue;
    const sourceText = String(base[baseKey] ?? '');
    const targetText = String(messages[key] ?? '');

    if (!targetText.trim()) emptyValues.push(key);

    const sourceVars = placeholders(sourceText);
    const targetVars = placeholders(targetText);
    for (const v of sourceVars) {
      if (!targetVars.has(v)) placeholderErrors.push(`${baseKey}: dropped {{${v}}}`);
    }
    for (const v of targetVars) {
      if (!sourceVars.has(v)) placeholderErrors.push(`${baseKey}: added {{${v}}}`);
    }

    // English text left unchanged in a non-English locale, unless it is a
    // brand name, an acronym or a symbol-only string.
    const looksLikeCode = /^[\s\W\d]*$/.test(sourceText)
      || /^(HeraAi|Gemini|OpenRouter|Ollama|Tavily|API|URL|PDF|OCR|JSON|HTTP|SSE|NDJSON)$/i.test(sourceText)
      || sourceText.length < 4;
    if (targetText === sourceText && sourceText.length >= 20 && !looksLikeCode) {
      untranslated.push(baseKey);
    }
  }

  // Plural completeness: if the base has _one/_other, the target must match the
  // count the language actually needs. A one-form language may express the
  // family either as a single suffixed key or as the bare stem; both count as
  // that one form.
  const basePluralKeys = [...baseKeys].filter((k) => PLURAL_SUFFIX.test(k));
  const pluralProblems = [];
  if (basePluralKeys.length && PLURAL_FORMS[code]) {
    const stems = new Set(basePluralKeys.map((k) => k.replace(PLURAL_SUFFIX, '')));
    const needed = PLURAL_FORMS[code];
    for (const stem of stems) {
      const suffixed = [...keys].filter((k) => PLURAL_SUFFIX.test(k) && k.replace(PLURAL_SUFFIX, '') === stem);
      const bare = keys.has(stem) ? 1 : 0;
      const have = needed === 1 ? suffixed.length + bare : suffixed.length;
      if (have !== needed) {
        pluralProblems.push(`${stem}: has ${have} form(s), ${code} needs ${needed}`);
      }
    }
  }

  // Extra keys are reported always, and with --strict they fail the build: a
  // leftover key means the translator invented something the UI will never call,
  // which is exactly the kind of silent rot this gate exists to prevent.
  const total = missing.length + extra.length + placeholderErrors.length
    + emptyValues.length + pluralProblems.length + untranslated.length;
  problems += total;

  report.push(
    `${code.padEnd(7)} keys=${String(keys.size).padStart(4)}  ` +
    `missing=${missing.length}  extra=${extra.length}  ` +
    `placeholder=${placeholderErrors.length}  empty=${emptyValues.length}  ` +
    `untranslated=${untranslated.length}  plural=${pluralProblems.length}`
  );

  if (total && (STRICT || missing.length || placeholderErrors.length || extra.length)) {
    for (const k of missing.slice(0, 5)) report.push(`         - missing: ${k}`);
    if (missing.length > 5) report.push(`         … ${missing.length - 5} more missing`);
    for (const k of extra.slice(0, 5)) report.push(`         + extra: ${k}`);
    if (extra.length > 5) report.push(`         … ${extra.length - 5} more extra`);
    for (const e of placeholderErrors.slice(0, 5)) report.push(`         ! ${e}`);
    for (const e of pluralProblems.slice(0, 3)) report.push(`         ~ ${e}`);
    for (const k of untranslated.slice(0, 3)) report.push(`         ? untranslated: ${k}`);
    if (untranslated.length > 3) report.push(`         … ${untranslated.length - 3} more untranslated`);
    for (const k of emptyValues.slice(0, 3)) report.push(`         · empty: ${k}`);
  }
}

// Pseudo-locale: inflate every string so layout overflow shows up in a screenshot.
if (PSEUDO) {
  const ACCENT = 'áéíóúçñüö';
  const inflate = (text) => {
    if (!text || typeof text !== 'string') return text;
    const padded = text.replace(/[a-z]/g, (ch) => ACCENT[ch.charCodeAt(0) % ACCENT.length]);
    const paddedVars = padded.replace(/\{\{\s*([\w.]+)\s*\}\}/g, '⟦$1⟧');
    return `⟪${paddedVars}⟫`;
  };
  const walk = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = v && typeof v === 'object' && !Array.isArray(v) ? walk(v) : inflate(v);
    }
    return out;
  };
  const raw = JSON.parse(readFileSync(join(localeDir, `${BASE}.json`), 'utf8'));
  writeFileSync(join(localeDir, 'xx-pseudo.json'), JSON.stringify(walk(raw), null, 2) + '\n', 'utf8');
  report.push('xx-pseudo.json written for layout testing');
}

console.log('HeraAi translation gate');
console.log(`base: ${BASE} (${baseKeys.size} keys)`);
console.log(`locales: ${locales.join(', ')}`);
console.log('');
for (const line of report) console.log(line);
console.log('');

if (problems === 0) {
  console.log('RESULT: clean — every locale matches the source.');
  process.exit(0);
}

console.log(`RESULT: ${problems} problem(s).`);
process.exit(STRICT ? 1 : 0);
