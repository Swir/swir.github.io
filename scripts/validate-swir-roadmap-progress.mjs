import fs from 'node:fs';

const roadmapPath = process.argv[2] || 'SWIR-OS-ARCHITECTURE.md';
const standardPath = process.argv[3] || 'SWIR-ROADMAP-STANDARD.md';
const roadmap = fs.readFileSync(roadmapPath, 'utf8');
const standard = fs.readFileSync(standardPath, 'utf8');

function fail(message) {
  console.error(`SWIR roadmap validation failed: ${message}`);
  process.exit(1);
}

function count(text, regex) {
  return [...text.matchAll(regex)].length;
}

const marker = '<!-- SWIR-ROADMAP-STANDARD:v1 -->';
const start = '<!-- ROADMAP-PROGRESS:START -->';
const end = '<!-- ROADMAP-PROGRESS:END -->';
if (count(roadmap, /<!-- SWIR-ROADMAP-STANDARD:v1 -->/g) !== 1) fail('standard v1 marker must appear exactly once');
if (count(roadmap, /<!-- ROADMAP-PROGRESS:START -->/g) !== 1 || count(roadmap, /<!-- ROADMAP-PROGRESS:END -->/g) !== 1) fail('progress block markers must appear exactly once');
if (!standard.includes(marker) || !standard.includes(start) || !standard.includes(end)) fail('canonical standard is missing required v1 markers');

const progressStart = roadmap.indexOf(start);
const progressEnd = roadmap.indexOf(end);
if (progressStart < 0 || progressEnd <= progressStart) fail('progress block ordering is invalid');
const progressBlock = roadmap.slice(progressStart, progressEnd + end.length);

for (const required of ['alt="CI"', 'alt="Roadmap progress"', 'alt="Completed"', 'alt="Status"', '## 📊 Overall progress', '| ✅ Completed | ⏳ Remaining | 📦 Total | 🎯 Progress |']) {
  if (!progressBlock.includes(required)) fail(`dashboard element missing: ${required}`);
}

const versionStart = roadmap.indexOf('## Version roadmap');
const versionEnd = roadmap.indexOf('\n## Development rule', versionStart);
if (versionStart < 0 || versionEnd <= versionStart) fail('Version roadmap section boundaries are missing');
const checklist = roadmap.slice(versionStart, versionEnd);
const completed = count(checklist, /^- \[x\] /gmi);
const remaining = count(checklist, /^- \[ \] /gm);
const total = completed + remaining;
if (total === 0) fail('Version roadmap has no measurable checklist items');

const percent = ((completed / total) * 100).toFixed(1);
const filled = Math.round((completed / total) * 20);
const bar = `${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${percent}%`;
const expected = {
  completed,
  remaining,
  total,
  percent,
  bar,
  roadmapBadge: `ROADMAP-${percent}%25-`,
  doneBadge: `DONE-${completed}%2F${total}-`,
  tableRow: `| **${completed}** | **${remaining}** | **${total}** | **${percent}%** |`
};

if (!progressBlock.includes(expected.roadmapBadge)) fail(`ROADMAP badge does not match checklist (${expected.roadmapBadge})`);
if (!progressBlock.includes(expected.doneBadge)) fail(`DONE badge does not match checklist (${expected.doneBadge})`);
if (!progressBlock.includes(expected.tableRow)) fail(`dashboard table does not match checklist (${expected.tableRow})`);
if (!progressBlock.includes(expected.bar)) fail(`20-segment progress bar does not match checklist (${expected.bar})`);
if (filled + (20 - filled) !== 20) fail('internal 20-segment bar calculation failed');

const barMatch = progressBlock.match(/```text\s*\n([█░]+)\s+(\d+\.\d+)%\s*\n```/);
if (!barMatch) fail('progress text bar is malformed');
if ([...barMatch[1]].length !== 20) fail('progress bar must contain exactly 20 segments');

const statusExpected = completed === total ? 'STATUS-COMPLETE-' : 'STATUS-IN%20PROGRESS-';
if (!progressBlock.includes(statusExpected)) fail(`STATUS badge is inconsistent with checklist (${statusExpected})`);

const result = {
  schema: 'swir.roadmap-progress-validation/1.0',
  standard: 'SWIR-ROADMAP-STANDARD:v1',
  roadmap: roadmapPath,
  completed,
  remaining,
  total,
  percent: Number(percent),
  filledSegments: filled,
  valid: true
};

if (process.argv.includes('--json')) console.log(JSON.stringify(result));
else console.log(`SWIR roadmap validation: OK — ${completed}/${total} (${percent}%), ${filled}/20 segments`);
