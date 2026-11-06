#!/usr/bin/env node
/**
 * Regenerate the native notification badge icons in
 * `assets/images/notifications/` from GitHub's Octicons (MIT, via the
 * `@primer/octicons-react` dependency): each is a white Octicon on a solid
 * circle in GitHub's colour for that event.
 *
 * macOS only, because PNGs are rendered with the built-in `sips` tool.
 *
 * Usage: node scripts/notification-icons/build.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = path.join(root, 'assets', 'images', 'notifications');
const iconsDir = path.join(root, 'node_modules', '@primer', 'octicons-react', 'dist', 'icons');

/** Badge name → Octicon component file and GitHub colour. */
const BADGES = {
  'pr-approved': ['CheckIcon', '#1f883d'],
  'changes-requested': ['FileDiffIcon', '#cf222e'],
  'issue-comment': ['CommentIcon', '#0969da'],
  'bot-comment': ['HubotIcon', '#1b7c83'],
  'review-requested': ['EyeIcon', '#bf8700'],
  'pr-merged': ['GitMergeIcon', '#8250df'],
  'pr-closed-without-merge': ['GitPullRequestClosedIcon', '#cf222e'],
  'ci-checks-passed': ['CheckCircleIcon', '#1f883d'],
  'ci-checks-failed': ['XCircleIcon', '#cf222e'],
  'review-commented': ['CodeReviewIcon', '#59636e'],
  'review-dismissed': ['XIcon', '#59636e'],
  mentioned: ['MentionIcon', '#0969da'],
  notification: ['BellIcon', '#59636e'],
  summary: ['InboxIcon', '#59636e'],
};

const CANVAS = 256;
const RADIUS = 124;
/** Glyph width inside the canvas. */
const GLYPH = 150;
/**
 * Extra stroke, in Octicon units, so the thin line icons stay legible at the
 * ~40pt size macOS draws notification thumbnails.
 */
const THICKEN = 0.9;

/**
 * Read an Octicon's SVG paths, preferring the 24px drawing.
 *
 * @param {string} component - The icon's component file name, e.g. `CheckIcon`.
 * @returns {{ size: number, paths: string[] }} The drawing size and path data.
 */
function readOcticon(component) {
  const source = readFileSync(path.join(iconsDir, `${component}.mjs`), 'utf8');
  const size = source.includes('"24": {') ? 24 : 16;
  const block = source.split(`"${size}": {`)[1].split('\n\t}')[0];
  const paths = [...block.matchAll(/d: "([^"]+)"/g)].map((m) => m[1]);
  if (paths.length === 0) {
    throw new Error(`No paths found for ${component}`);
  }
  return { size, paths };
}

const work = mkdtempSync(path.join(tmpdir(), 'gitify-notification-icons-'));
try {
  for (const [name, [component, colour]] of Object.entries(BADGES)) {
    const { size, paths } = readOcticon(component);
    const scale = GLYPH / size;
    const offset = (CANVAS - GLYPH) / 2;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">` +
      `<circle cx="${CANVAS / 2}" cy="${CANVAS / 2}" r="${RADIUS}" fill="${colour}"/>` +
      `<g fill="#ffffff" stroke="#ffffff" stroke-width="${THICKEN}" stroke-linejoin="round" ` +
      `transform="translate(${offset} ${offset}) scale(${scale})">` +
      paths.map((d) => `<path d="${d}"/>`).join('') +
      '</g></svg>';
    const svgPath = path.join(work, `${name}.svg`);
    writeFileSync(svgPath, svg);
    execFileSync('sips', [
      '-s',
      'format',
      'png',
      '-z',
      String(CANVAS),
      String(CANVAS),
      svgPath,
      '--out',
      path.join(outDir, `${name}.png`),
    ]);
    // oxlint-disable-next-line no-console -- CLI script output
    console.log(`${name}.png  ←  ${component}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
