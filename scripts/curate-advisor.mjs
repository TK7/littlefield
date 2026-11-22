// Pick advisor answers for the portfolio version.
//
//   1. While signed in, save https://littlefield.jay.systems/api/chatlog?format=json as log.json
//   2. node scripts/curate-advisor.mjs log.json            lists every entry with its number
//   3. node scripts/curate-advisor.mjs log.json 3 7 12     writes those to public/advisor-examples.json
//
// Emails, telemetry and token counts are left out; only the question, the answer, the
// snapshot day and the briefing type are kept.
import { readFileSync, writeFileSync } from 'node:fs';

const [file, ...picks] = process.argv.slice(2);
if (!file) { console.error('Usage: node scripts/curate-advisor.mjs log.json [numbers...]'); process.exit(1); }
const { entries = [] } = JSON.parse(readFileSync(file, 'utf8'));
const usable = entries.filter((e) => e.answer && !e.note);

if (!picks.length) {
  usable.forEach((e, i) => console.log(String(i + 1).padStart(3) + '  Day ' + String(e.snapshotDay).padStart(3) + '  '
    + (e.briefing ? '[' + e.briefing + '] ' : '') + e.question.replace(/\s+/g, ' ').slice(0, 90)));
  console.log('\n' + usable.length + ' complete answers. Pass the numbers to keep.');
  process.exit(0);
}

const examples = picks.map((n) => {
  const e = usable[Number(n) - 1];
  if (!e) throw new Error('No entry ' + n);
  return { snapshotDay: e.snapshotDay, briefing: e.briefing || null, question: e.briefing ? briefingLabel(e.briefing) : e.question, answer: e.answer, model: e.model };
});
const out = new URL('../public/advisor-examples.json', import.meta.url);
writeFileSync(out, JSON.stringify({ note: 'Saved advisor answers shown in the portfolio version.', examples }, null, 2) + '\n');
console.log('Wrote ' + examples.length + ' examples to public/advisor-examples.json');

function briefingLabel(b) {
  return { audit: 'Audit latest upload', contract: 'Contract switch readiness', competitors: 'Competitor cash forensics', endgame: 'End-game kit order' }[b] || b;
}
