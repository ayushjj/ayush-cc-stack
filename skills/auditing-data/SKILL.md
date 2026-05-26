---
name: auditing-data
description: Verify data integrity after database modifications. Use after batch operations, schema migrations, data imports, or periodically as health check. Triggers on "audit", "verify data", "check integrity", "data health", "after migration".
preconditions:
  - Database modification has been made
  - Or periodic health check requested
  - Have access to run SQL queries
---

# Auditing Data

Use this skill AFTER any database modification to verify data integrity.

<critical_sequence enforce_order="strict">

<step number="1" required="true" blocking="true">
## Step 1: Record Count Verification

Compare before/after counts:

```sql
-- Before/after comparison
SELECT
  'expected' as state, [expected_count] as count
UNION ALL
SELECT
  'actual' as state, COUNT(*) as count FROM main_table;
```

Or if tracking changes:

```sql
SELECT COUNT(*) as total_records,
       COUNT(*) FILTER (WHERE updated_at > '[operation_start_time]') as modified
FROM table;
```

<validation_gate name="counts-verified" blocking="true">
**BLOCK if counts don't match:**
- [ ] Total record count matches expected
- [ ] Modified record count matches dry-run
- [ ] No unexpected deletions

Investigate any count discrepancy before proceeding.
</validation_gate>
</step>

<step number="2" required="true" depends_on="1" blocking="true">
## Step 2: Orphan Detection

Find records with broken foreign keys:

```sql
-- Find records with broken foreign keys
SELECT c.id, c.parent_id
FROM child_table c
LEFT JOIN parent_table p ON c.parent_id = p.id
WHERE c.parent_id IS NOT NULL AND p.id IS NULL;
```

Run for every foreign key relationship affected by the change.

<validation_gate name="orphans-checked" blocking="true">
**BLOCK if orphans exist:**
- [ ] All FK relationships verified
- [ ] Zero orphaned records found
- [ ] Or orphans are expected and documented

Orphans indicate data corruption. Fix before proceeding.
</validation_gate>
</step>

<step number="3" required="true" depends_on="1" blocking="true">
## Step 3: Duplicate Detection

Find duplicates on fields that should be unique:

```sql
-- Find duplicates on unique fields
SELECT field1, field2, COUNT(*) as count
FROM table
GROUP BY field1, field2
HAVING COUNT(*) > 1;
```

<validation_gate name="duplicates-checked" blocking="true">
**BLOCK if duplicates exist:**
- [ ] All unique fields checked
- [ ] Zero duplicate records found
- [ ] Or duplicates are expected and documented

Duplicates often indicate race conditions in batch operations.
</validation_gate>
</step>

<step number="4" required="true" depends_on="1">
## Step 4: Timestamp Consistency

Check for timestamp anomalies:

```sql
-- Find records with future timestamps
SELECT * FROM table WHERE created_at > NOW();

-- Find records with inconsistent timestamps
SELECT * FROM table WHERE updated_at < created_at;

-- Find records with suspicious timestamps (too old or too new)
SELECT * FROM table
WHERE created_at < '2020-01-01'
   OR created_at > NOW() + INTERVAL '1 day';
```
</step>

<step number="5" required="true" depends_on="1">
## Step 5: Foreign Key Integrity

Verify all FK relationships are valid:

```sql
-- Verify all FK relationships are valid
SELECT
  'table1->table2' as relationship,
  COUNT(*) as broken_links
FROM table1 t1
LEFT JOIN table2 t2 ON t1.fk_id = t2.id
WHERE t1.fk_id IS NOT NULL AND t2.id IS NULL;
```

Repeat for each relationship.
</step>

<step number="6" required="true" depends_on="1">
## Step 6: Business Rule Compliance

Check project-specific rules:

```sql
-- All providers must have phone_e164
SELECT * FROM providers WHERE phone_e164 IS NULL;

-- All recommendations must have source
SELECT * FROM recommendations WHERE source IS NULL;

-- All requests must have category
SELECT * FROM requests WHERE category IS NULL;

-- Confidence scores in valid range
SELECT * FROM table WHERE confidence < 0 OR confidence > 1;
```

Add checks specific to your domain.
</step>

</critical_sequence>

## Audit Script Template

Create `scripts/audit/{operation}-audit.ts`:

```typescript
import { db } from '../db/client';

interface AuditResult {
  check: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  details: string;
  count?: number;
}

async function runAudit(): Promise<AuditResult[]> {
  const results: AuditResult[] = [];

  // Check 1: Record count
  const count = await db.query('SELECT COUNT(*) FROM table');
  results.push({
    check: 'Record Count',
    status: count[0].count > 0 ? 'PASS' : 'WARN',
    details: `Found ${count[0].count} records`,
    count: count[0].count
  });

  // Check 2: Orphans
  const orphans = await db.query(`
    SELECT COUNT(*) FROM child
    LEFT JOIN parent ON child.parent_id = parent.id
    WHERE child.parent_id IS NOT NULL AND parent.id IS NULL
  `);
  results.push({
    check: 'Orphan Records',
    status: orphans[0].count === 0 ? 'PASS' : 'FAIL',
    details: orphans[0].count === 0 ? 'No orphans' : `Found ${orphans[0].count} orphans`,
    count: orphans[0].count
  });

  // Check 3: Duplicates
  const dupes = await db.query(`
    SELECT COUNT(*) as dupe_groups FROM (
      SELECT field, COUNT(*) FROM table
      GROUP BY field HAVING COUNT(*) > 1
    ) subq
  `);
  results.push({
    check: 'Duplicate Records',
    status: dupes[0].dupe_groups === 0 ? 'PASS' : 'FAIL',
    details: dupes[0].dupe_groups === 0 ? 'No duplicates' : `Found ${dupes[0].dupe_groups} duplicate groups`,
    count: dupes[0].dupe_groups
  });

  return results;
}

// Run and output
runAudit().then(results => {
  console.log('\n=== AUDIT RESULTS ===\n');

  let hasFailures = false;
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : '⚠';
    console.log(`${icon} ${r.check}: ${r.status}`);
    console.log(`  ${r.details}\n`);
    if (r.status === 'FAIL') hasFailures = true;
  }

  process.exit(hasFailures ? 1 : 0);
});
```

## Output Format

```
=== AUDIT RESULTS ===

✓ Record Count: PASS
  Found 1,247 records

✗ Orphan Records: FAIL
  Found 3 orphans

✓ Duplicate Records: PASS
  No duplicates

⚠ Timestamp Consistency: WARN
  Found 2 records with future timestamps
```

<success_criteria>
## Audit Complete When ALL Are True

- [ ] Record counts verified
- [ ] Zero orphaned records (or documented exceptions)
- [ ] Zero duplicate records (or documented exceptions)
- [ ] Timestamp consistency verified
- [ ] All FK relationships valid
- [ ] Business rules compliance checked
- [ ] Results documented
</success_criteria>

<decision_gate wait_for_user="true">
## Audit Complete

Status: [PASSED / FAILED / WARNINGS]

Results summary:
- Record count: [PASS/FAIL]
- Orphans: [PASS/FAIL]
- Duplicates: [PASS/FAIL]
- Timestamps: [PASS/WARN/FAIL]
- FK integrity: [PASS/FAIL]
- Business rules: [PASS/FAIL]

What's next?
1. Proceed (audit passed)
2. Fix issues and re-audit
3. Rollback changes
4. Document learnings
5. Other

Choose (1-5): _
</decision_gate>

## When Audit Fails

1. DO NOT proceed with next steps
2. Investigate the specific failures
3. Fix root cause (not just symptoms)
4. Re-run audit until all checks pass
5. Document what was wrong and how it was fixed

<integration_protocol>
## Integration Points

**Invoked by:**
- `/batch` skill (after execution)
- Manual invocation for health checks
- Auto-suggested after database modifications

**Invokes:**
- `/wrap` skill (to document issues found at session end)

**Handoff expectations:**
Receives context about what operation was performed.
Uses dry-run output from /batch to compare expected vs actual.
</integration_protocol>
