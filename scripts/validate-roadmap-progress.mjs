import fs from 'node:fs';

const ROADMAP='SWIR-OS-ARCHITECTURE.md';
const STANDARD='SWIR-ROADMAP-STANDARD.md';
const text=fs.readFileSync(ROADMAP,'utf8');
const standard=fs.readFileSync(STANDARD,'utf8');
const fail=message=>{throw new Error(`SWIR_ROADMAP_CONTRACT: ${message}`)};
const occurrences=(haystack,needle)=>haystack.split(needle).length-1;

const marker='<!-- SWIR-ROADMAP-STANDARD:v1 -->';
const start='<!-- ROADMAP-PROGRESS:START -->';
const end='<!-- ROADMAP-PROGRESS:END -->';
for(const token of [marker,start,end]){
  if(occurrences(text,token)!==1)fail(`${token} must appear exactly once`);
}
for(const required of [
  '## 📊 Overall progress',
  'alt="CI"',
  'alt="Roadmap progress"',
  'alt="Completed"',
  'alt="Status"',
  '| ✅ Completed | ⏳ Remaining | 📦 Total | 🎯 Progress |'
]){
  if(!text.includes(required))fail(`missing locked dashboard element: ${required}`);
}
if(!standard.includes(marker)||!standard.includes('The text bar always has exactly 20 segments')){
  fail('canonical SWIR Roadmap Standard v1 is missing or invalid');
}
if(text.indexOf(marker)>text.indexOf(start))fail('style marker must appear before progress block');
if(text.indexOf(start)>text.indexOf(end))fail('progress block markers are out of order');

const roadmapStart=text.indexOf('## Version roadmap');
const roadmapEnd=text.indexOf('\n---\n\n## Development rule',roadmapStart);
if(roadmapStart<0||roadmapEnd<0)fail('Version roadmap boundaries are missing');
const checklist=text.slice(roadmapStart,roadmapEnd);
const completed=(checklist.match(/^- \[x\] /gm)||[]).length;
const remaining=(checklist.match(/^- \[ \] /gm)||[]).length;
const total=completed+remaining;
if(total===0)fail('Version roadmap contains no deliverables');

const ratio=completed/total;
const percent=Number((ratio*100).toFixed(1));
const percentText=percent.toFixed(1);
const filled=Math.round(ratio*20);
const bar='█'.repeat(filled)+'░'.repeat(20-filled);
if([...bar].length!==20)fail('internal progress bar calculation is not 20 segments');

const progressBlock=text.slice(text.indexOf(start),text.indexOf(end)+end.length);
const exact=[
  `https://img.shields.io/badge/ROADMAP-${percentText}%25-2ea043?style=for-the-badge`,
  `https://img.shields.io/badge/DONE-${completed}%2F${total}-1f6feb?style=for-the-badge`,
  `${bar} ${percentText}%`,
  `| **${completed}** | **${remaining}** | **${total}** | **${percentText}%** |`
];
for(const expected of exact){
  if(!progressBlock.includes(expected))fail(`dashboard is stale; expected: ${expected}`);
}

const barMatch=progressBlock.match(/```text\s*\n([█░]+)\s+(\d+\.\d+)%\s*\n```/);
if(!barMatch)fail('progress text bar is malformed');
if([...barMatch[1]].length!==20)fail('rendered progress bar must contain exactly 20 segments');
if(barMatch[1]!==bar||barMatch[2]!==percentText)fail('rendered progress bar does not match checklist state');

const statusMatches=[...progressBlock.matchAll(/https:\/\/img\.shields\.io\/badge\/STATUS-([^"?]+)-7c3aed\?style=for-the-badge/g)];
if(statusMatches.length!==1)fail('dashboard must contain exactly one STATUS badge matching SWIR Roadmap Standard v1');
const status=decodeURIComponent(statusMatches[0][1]);
if(percent===100&&status!=='COMPLETE')fail('100% roadmap must use COMPLETE status');
if(percent<100&&status==='COMPLETE')fail('incomplete roadmap must not use COMPLETE status');

const allCheckboxes=(text.match(/^- \[(?:x| )\] /gm)||[]).length;
if(allCheckboxes!==total)fail(`all roadmap deliverable checkboxes must live inside Version roadmap (${allCheckboxes} total vs ${total} scoped)`);

console.log(`SWIR roadmap contract OK: ${completed}/${total} complete, ${remaining} remaining, ${percentText}%, ${bar}`);
