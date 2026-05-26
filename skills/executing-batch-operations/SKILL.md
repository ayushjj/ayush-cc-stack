---
name: executing-batch-operations
description: Safely execute operations affecting multiple records with dry-run, sample, execute, verify workflow. Use for database migrations, bulk updates/deletes, data transformations, any operation on more than 10 records. Triggers on "batch", "bulk", "migrate", "update all", "delete multiple", "mass update".
preconditions:
  - Operation affects more than 10 records
  - Have spec or clear understanding of what needs to change
  - Database backup exists or can be created
---

# Executing Batch Operations

Use this skill for ANY operation affecting multiple records. Prevents catastrophic data loss.

## The Golden Rule

**Dry-run -> Sample Review -> Execute -> Verify**

Never skip steps. Every step exists because of past pain.

<critical_sequence enforce_order="strict">

<step number="1" required="true" blocking="true">
## Step 1: Create Dry-Run Script

Add a `--dry-run` flag that:
- Shows what WOULD change without changing it
- Outputs affected record IDs
- Counts total affected records

For a full template with dry-run, rollback, and confirmation, read `scripts/batch-template.ts`.

<validation_gate name="dry-run-implemented" blocking="true">
**BLOCK if not implemented:**
- [ ] Script has --dry-run flag
- [ ] Dry-run shows count of affected records
- [ ] Dry-run shows sample of affected IDs
- [ ] Dry-run makes NO changes to data

Do NOT proceed until dry-run works correctly.
</validation_gate>
</step>

<step number="2" required="true" depends_on="1" blocking="true">
## Step 2: Run on Sample (10%)

```bash
pnpm tsx scripts/batch-operation.ts --dry-run --limit 10
```

Review output manually:
- Are the right records selected?
- Is the transformation correct?
- Any unexpected cases?

<validation_gate name="sample-reviewed" blocking="true">
**BLOCK if sample not reviewed:**
- [ ] Ran with --limit flag (10% or 10 records, whichever smaller)
- [ ] Manually reviewed each record in output
- [ ] Confirmed transformation logic is correct
- [ ] No unexpected records included

Do NOT proceed to full dry-run until sample looks correct.
</validation_gate>
</step>

<step number="3" required="true" depends_on="2" blocking="true">
## Step 3: Full Dry-Run

```bash
pnpm tsx scripts/batch-operation.ts --dry-run > dry-run-output.txt
```

Review the full output:
- Total count matches expectation?
- Edge cases handled?
- No unexpected records included?

<validation_gate name="full-dry-run-reviewed" blocking="true">
**BLOCK if not reviewed:**
- [ ] Full dry-run output saved to file
- [ ] Total count matches expectation
- [ ] Spot-checked random records in output
- [ ] Edge cases verified

Save this file - you'll need it for audit.
</validation_gate>
</step>

<step number="4" required="true" depends_on="3" blocking="true">
## Step 4: Create Rollback File

Before execution, save current state (see `scripts/batch-template.ts` for rollback pattern).

<validation_gate name="rollback-created" blocking="true">
**BLOCK if not created:**
- [ ] Rollback file exists with original values
- [ ] File is named with date for identification
- [ ] Rollback restore script ready (if needed)

You WILL need this rollback file. Create it.
</validation_gate>
</step>

<step number="5" required="true" depends_on="4" blocking="true">
## Step 5: Execute with Confirmation

```bash
pnpm tsx scripts/batch-operation.ts
```

Script must have confirmation prompt (see `scripts/batch-template.ts` for pattern).

<validation_gate name="execution-confirmed" blocking="true">
**BLOCK if not ready:**
- [ ] Confirmation prompt exists in script
- [ ] User has typed 'yes' to proceed
- [ ] Execution is logged for audit

This is the point of no return. Confirm everything is ready.
</validation_gate>
</step>

<step number="6" required="true" depends_on="5" blocking="true">
## Step 6: Verify with Audit Query

After execution, run verification immediately:

```sql
-- Check expected count
SELECT COUNT(*) FROM table WHERE condition;

-- Check for orphans
SELECT * FROM table WHERE foreign_key IS NULL AND should_have_fk;

-- Check for duplicates
SELECT field, COUNT(*) FROM table GROUP BY field HAVING COUNT(*) > 1;
```

<validation_gate name="audit-passed" blocking="true">
**BLOCK if audit fails:**
- [ ] Record count matches expected
- [ ] No orphaned records created
- [ ] No duplicate records created
- [ ] Spot-check shows correct values

If ANY check fails, STOP and investigate before proceeding.
</validation_gate>
</step>

<step number="7" required="true" depends_on="6">
## Step 7: Document Results

Update `implementation.md` or create new documentation:

```markdown
## Batch Operation: {name}
- Date: {date}
- Records affected: {count}
- Dry-run file: dry-run-output.txt
- Rollback file: rollback-{operation}-{date}.json
- Verification: [PASSED/FAILED]
```
</step>

</critical_sequence>

## Safety Checklist

Before executing any batch operation:

- [ ] Dry-run flag implemented
- [ ] Sample (10%) reviewed manually
- [ ] Full dry-run output saved
- [ ] Rollback file created
- [ ] Confirmation prompt added
- [ ] Audit queries written
- [ ] Results documented

<success_criteria>
## Batch Operation Complete When ALL Are True

- [ ] Dry-run completed and reviewed
- [ ] Rollback file exists
- [ ] Execution confirmed by user
- [ ] Audit queries all pass
- [ ] Results documented
- [ ] No orphans or duplicates created
</success_criteria>

<decision_gate wait_for_user="true">
## Batch Operation Complete

Affected records: [count]
Audit status: [PASSED/FAILED]

What's next?
1. Run /audit for full data integrity check (recommended)
2. Proceed to next step in implementation
3. Rollback changes (if issues found)
4. Document learnings with /learnings
5. Other

Choose (1-5): _
</decision_gate>

## Anti-Patterns

- Running batch operations in production without dry-run
- Skipping sample review "because it's simple"
- No rollback file (you WILL need it)
- Verification after, not during (catch issues early)
- Not saving dry-run output (needed for audit)

<integration_protocol>
## Integration Points

**Invoked by:**
- `/spec` skill (when implementation involves bulk changes)
- Manual invocation for data migrations
- Auto-suggested when user mentions bulk operations

**Invokes:**
- `/audit` skill (after execution to verify data integrity)

**Handoff expectations:**
Creates rollback file and dry-run output.
/audit skill uses these to verify integrity.
</integration_protocol>
