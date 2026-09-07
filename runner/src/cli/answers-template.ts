// Renders an `answers:` mapping file in the restricted YAML dialect `yaml.ts`
// reads (goals spec section 24), so the output round-trips through
// `readYamlFile`/`readAnswersFile` unmodified. That dialect's only scalar
// forms are a bare token or a double-quoted string with no escape mechanism,
// so a default containing a `"` or a newline cannot be represented; such a
// default, or a missing one, is written as an empty placeholder preceded by
// a whole-line comment naming the entry and the reason it is blank.

export interface AnswerTemplateEntry {
  id: string;
  safeDefault: string | null;
}

export interface AnswerTemplateResult {
  text: string;
  prefilledCount: number;
  blankCount: number;
}

const UNREPRESENTABLE_DEFAULT = /["\n]/;

export function renderAnswersTemplate(entries: readonly AnswerTemplateEntry[]): AnswerTemplateResult {
  const lines: string[] = ["answers:"];
  let prefilledCount = 0;
  let blankCount = 0;

  for (const entry of entries) {
    if (entry.safeDefault !== null && !UNREPRESENTABLE_DEFAULT.test(entry.safeDefault)) {
      lines.push(`  ${entry.id}: "${entry.safeDefault}"`);
      prefilledCount++;
      continue;
    }

    const reason =
      entry.safeDefault === null
        ? `${entry.id} has no default and must be answered by hand`
        : `${entry.id}'s default is not representable in this file format and must be filled in by hand`;
    lines.push(`  # ${reason}`);
    lines.push(`  ${entry.id}: ""`);
    blankCount++;
  }

  return { text: `${lines.join("\n")}\n`, prefilledCount, blankCount };
}
