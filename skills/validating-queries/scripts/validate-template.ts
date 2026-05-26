/**
 * Query validation template — adapt for each validation session.
 * Runs test queries against real data and calculates precision/recall.
 *
 * Usage:
 *   pnpm tsx scripts/validate-{feature}.ts
 */

import * as fs from 'fs';

interface ValidationCase {
  query: string;
  expectedIndustry: string;
  expectedLocation?: string;
  minResults: number;
  maxResults: number;
}

const cases: ValidationCase[] = [
  {
    query: "real estate broker thane",
    expectedIndustry: "Real Estate",
    expectedLocation: "Thane",
    minResults: 3,
    maxResults: 10,
  },
  // Add more cases...
];

async function search(query: string): Promise<Array<{ id: string; name: string; industry: string; location?: string }>> {
  // Replace with actual search call
  throw new Error('Implement search with your search function');
}

async function validate() {
  for (const c of cases) {
    console.log(`\n=== Query: "${c.query}" ===\n`);

    const results = await search(c.query);

    // Check count
    const countOk = results.length >= c.minResults && results.length <= c.maxResults;
    console.log(`Count: ${results.length} ${countOk ? '\u2713' : '\u2717'} (expected ${c.minResults}-${c.maxResults})`);

    // Check each result
    let correct = 0;
    for (const r of results) {
      const industryMatch = r.industry === c.expectedIndustry;
      const locationMatch = !c.expectedLocation || r.location?.includes(c.expectedLocation);
      const isCorrect = industryMatch && locationMatch;

      console.log(`${isCorrect ? '\u2713' : '\u2717'} ${r.name} - ${r.industry} - ${r.location}`);
      if (isCorrect) correct++;
    }

    console.log(`\nPrecision: ${correct}/${results.length} (${Math.round((correct / results.length) * 100)}%)`);
  }
}

/**
 * Before/after comparison — use when validating a code change.
 */
async function compareBeforeAfter(query: string) {
  // Save "before" results
  const before = await search(query);
  fs.writeFileSync('before.json', JSON.stringify(before, null, 2));

  // Apply change, then run "after"
  const after = await search(query);
  fs.writeFileSync('after.json', JSON.stringify(after, null, 2));

  // Compare
  console.log('=== COMPARISON ===');
  console.log(`Before: ${before.length} results`);
  console.log(`After: ${after.length} results`);

  // Find removed results
  const removed = before.filter(b => !after.find(a => a.id === b.id));
  console.log(`\nRemoved (${removed.length}):`);
  removed.forEach(r => console.log(`  - ${r.name}`));

  // Find added results
  const added = after.filter(a => !before.find(b => b.id === a.id));
  console.log(`\nAdded (${added.length}):`);
  added.forEach(r => console.log(`  + ${r.name}`));
}

validate().catch(console.error);
