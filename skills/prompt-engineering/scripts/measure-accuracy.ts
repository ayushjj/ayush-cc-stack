/**
 * LLM accuracy measurement template — adapt for each tuning session.
 * Measures baseline accuracy and compares prompt approaches.
 *
 * Usage:
 *   pnpm tsx scripts/measure-accuracy.ts
 */

interface TestCase {
  input: string;
  expected: string;  // Expected output/classification
  category: string;  // Edge case category
  notes?: string;    // Why this case matters
}

// Minimum 10 test cases: 3+ positive, 3+ negative, 3+ edge cases
export const testCases: TestCase[] = [
  // Happy path cases (3-4)
  { input: "Looking for a plumber", expected: "service_request", category: "clear_request" },

  // Edge cases (3-4)
  { input: "Hi anyone know a good plumber?", expected: "service_request", category: "greeting_prefix" },

  // Negative cases (3-4)
  { input: "Good morning everyone!", expected: "greeting", category: "pure_greeting" },
];

async function measureAccuracy(prompt: string): Promise<{
  accuracy: number;
  failures: Array<TestCase & { actual: string }>;
}> {
  let correct = 0;
  const failures: Array<TestCase & { actual: string }> = [];

  for (const tc of testCases) {
    const result = await runLLM(prompt, tc.input);
    if (result === tc.expected) {
      correct++;
    } else {
      failures.push({ ...tc, actual: result });
    }
  }

  return {
    accuracy: correct / testCases.length,
    failures,
  };
}

async function runLLM(prompt: string, input: string): Promise<string> {
  // Replace with actual LLM call
  throw new Error('Implement runLLM with your LLM client');
}

async function main() {
  const prompt = ''; // Your current prompt
  const { accuracy, failures } = await measureAccuracy(prompt);

  console.log(`\n=== Baseline Accuracy ===`);
  console.log(`Accuracy: ${(accuracy * 100).toFixed(1)}% (${testCases.length - failures.length}/${testCases.length} correct)`);

  if (failures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) {
      console.log(`  [${f.category}] "${f.input}"`);
      console.log(`    Expected: ${f.expected}, Got: ${f.actual}`);
    }
  }
}

main().catch(console.error);
