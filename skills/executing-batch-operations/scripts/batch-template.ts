/**
 * Batch operation template — adapt for each operation.
 * Includes: dry-run flag, rollback file, confirmation prompt, audit queries.
 *
 * Usage:
 *   pnpm tsx scripts/batch-operation.ts --dry-run          # Preview changes
 *   pnpm tsx scripts/batch-operation.ts --dry-run --limit 10  # Sample 10%
 *   pnpm tsx scripts/batch-operation.ts                    # Execute with confirmation
 */

import * as fs from 'fs';
import * as readline from 'readline';

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = process.argv.includes('--limit')
  ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10)
  : undefined;

async function main() {
  // 1. Fetch records to process
  // const records = await db.select().from(table).where(...);
  const records: Array<{ id: string; field_to_change: string }> = []; // Replace

  const subset = LIMIT ? records.slice(0, LIMIT) : records;

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would update ${subset.length} of ${records.length} records`);
    console.log(`[DRY RUN] Sample IDs: ${subset.slice(0, 10).map(r => r.id)}`);
    for (const r of subset) {
      // Show what would change
      console.log(`  ${r.id}: ${r.field_to_change} → [new value]`);
    }
    return;
  }

  // 2. Save rollback file BEFORE execution
  const rollback = subset.map(r => ({
    id: r.id,
    original_value: r.field_to_change,
  }));
  const rollbackPath = `rollback-operation-${new Date().toISOString().split('T')[0]}.json`;
  fs.writeFileSync(rollbackPath, JSON.stringify(rollback, null, 2));
  console.log(`Rollback file saved: ${rollbackPath}`);

  // 3. Confirmation prompt
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => {
    rl.question(`About to update ${subset.length} records. Type 'yes' to proceed: `, resolve);
  });
  rl.close();

  if (answer !== 'yes') {
    console.log('Aborted');
    process.exit(0);
  }

  // 4. Execute
  for (const r of subset) {
    // await db.update(table).set({ field: newValue }).where(eq(table.id, r.id));
    console.log(`Updated ${r.id}`);
  }

  console.log(`\nDone. Updated ${subset.length} records.`);

  // 5. Verify with audit queries
  // const count = await db.select({ count: sql`count(*)` }).from(table).where(...);
  // console.log(`Verification: ${count} records match expected state`);
}

main().catch(console.error);
