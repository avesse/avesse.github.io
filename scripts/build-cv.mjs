#!/usr/bin/env node
// Reads local-content/cv.md, applies redactions (phone + testimonial names),
// and emits cv/john-murray-cv.md, cv/index.html, cv/john-murray-cv.pdf.
//
// Run: npm run build:cv  (or `npm run build:cv:html` to skip the PDF)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { marked } from 'marked';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const SOURCE = join(ROOT, 'local-content/cv.md');
const TEMPLATE = join(__dirname, 'cv-template.html');
const OUT_DIR = join(ROOT, 'cv');
const OUT_MD = join(OUT_DIR, 'john-murray-cv.md');
const OUT_HTML = join(OUT_DIR, 'index.html');
const OUT_PDF = join(OUT_DIR, 'john-murray-cv.pdf');

const SKIP_PDF = process.argv.includes('--skip-pdf');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

// ─── Redaction ─────────────────────────────────────────────────────
function redact(md) {
  // Strip phone number from the contact line: " | +<digits>"
  let out = md.replace(/ \| \+\d+/g, '');

  // Within `# Testimonials`, rewrite `### Name - Title` to `### Title`
  const idx = out.search(/^# Testimonials$/m);
  if (idx !== -1) {
    const before = out.slice(0, idx);
    const after = out.slice(idx);
    out = before + after.replace(/^### [^\n]+? - (.+)$/gm, '### $1');
  }
  return out;
}

// ─── Shorten bare URLs to short labelled links ─────────────────────
function shortenLinks(md) {
  return md.replace(
    /\blinkedin\.com\/in\/([^\s|)\]]+)/gi,
    '[linkedin](https://linkedin.com/in/$1)'
  );
}

// ─── H1 metadata for nav + section ids ─────────────────────────────
function extractH1s(md) {
  const result = [];
  const re = /^# (.+)$/gm;
  let m;
  while ((m = re.exec(md)) !== null) {
    const title = m[1].trim();
    const navLabel = title.split(/ - | & /)[0].trim();
    const id = navLabel
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    result.push({ title, navLabel, id });
  }
  return result;
}

// ─── HTML post-processing ──────────────────────────────────────────
function applyHeadingIds(html, h1s) {
  let i = 0;
  return html.replace(/<h1>(.*?)<\/h1>/gs, (m, content) => {
    const item = h1s[i++];
    return item ? `<h1 id="${item.id}">${content}</h1>` : m;
  });
}

function styleHeadingSubtitles(html) {
  return html
    .replace(/<h1([^>]*)>(.+?)<\/h1>/gs, (m, attrs, text) => {
      const idx = text.indexOf(' - ');
      if (idx === -1) return m;
      return `<h1${attrs}>${text.slice(0, idx)} <span class="title-suffix">— ${text.slice(idx + 3)}</span></h1>`;
    })
    .replace(/<h2>(.+?)<\/h2>/gs, (m, text) => {
      const idx = text.indexOf(' - ');
      if (idx === -1) return m;
      return `<h2>${text.slice(0, idx)} <span class="role">— ${text.slice(idx + 3)}</span></h2>`;
    });
}

function stylePeriodParagraphs(html) {
  return html.replace(/<p><em>([^<]+)<\/em><\/p>/g, '<p class="period">$1</p>');
}

function fixTables(html) {
  return html
    // Drop empty <thead> when the header row only has empty <th> cells
    .replace(/<thead>\s*<tr>(?:\s*<th[^>]*><\/th>)+\s*<\/tr>\s*<\/thead>/g, '')
    // First <td> in each <tr> becomes a <th> (label column)
    .replace(/<tr>\s*<td[^>]*>([^<]*)<\/td>/g, '<tr><th>$1</th>');
}

function wrapInSections(html, h1s) {
  const parts = html.split(/(<h1[^>]*>.*?<\/h1>)/s);
  if (parts.length < 2) return html;

  let out = parts[0];
  for (let i = 1; i < parts.length; i += 2) {
    const h1Element = parts[i];
    const content = parts[i + 1] || '';
    const idMatch = h1Element.match(/id="([^"]+)"/);
    const id = idMatch ? idMatch[1] : '';
    out += `<section id="${id}">${h1Element}${content}</section>`;
  }
  return out;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ─── PDF via headless Chrome ───────────────────────────────────────
async function generatePDF(htmlPath, pdfPath) {
  const chromePath = CHROME_CANDIDATES.find(p => existsSync(p));
  if (!chromePath) {
    throw new Error('Chrome/Chromium not found. Install Chrome, or run with --skip-pdf.');
  }
  const cmd = [
    `"${chromePath}"`,
    '--headless=new',
    '--disable-gpu',
    '--no-pdf-header-footer',
    '--virtual-time-budget=10000',
    `--print-to-pdf="${pdfPath}"`,
    `"file://${htmlPath}"`,
  ].join(' ');
  await execAsync(cmd);
}

// ─── Build ─────────────────────────────────────────────────────────
async function build() {
  const source = await readFile(SOURCE, 'utf-8');
  const md = shortenLinks(redact(source));

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_MD, md);
  console.log(`  → ${OUT_MD}`);

  const h1s = extractH1s(md);

  marked.setOptions({ gfm: true, breaks: false });
  let html = await marked.parse(md);

  html = applyHeadingIds(html, h1s);
  html = styleHeadingSubtitles(html);
  html = stylePeriodParagraphs(html);
  html = fixTables(html);
  html = wrapInSections(html, h1s);

  const navHtml = h1s
    .map(({ navLabel, id }) =>
      `    <li><a href="#${id}" class="nav-link">${escapeHtml(navLabel)}</a></li>`)
    .join('\n');

  const template = await readFile(TEMPLATE, 'utf-8');
  const finalHtml = template
    .replace('{{NAV}}', navHtml)
    .replace('{{CONTENT}}', html);

  await writeFile(OUT_HTML, finalHtml);
  console.log(`  → ${OUT_HTML}`);

  if (SKIP_PDF) {
    console.log('  (skipped PDF — --skip-pdf)');
    return;
  }

  await generatePDF(OUT_HTML, OUT_PDF);
  console.log(`  → ${OUT_PDF}`);
}

build().catch(err => {
  console.error('Build failed:', err.message);
  process.exit(1);
});
