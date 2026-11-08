/** Narrow corrections to the original shared helper; no replacement reducer. */
export const patchQuestionAnswers = patch => {
  const file = 'packages/client-runtime/src/state/pendingUserInput.ts'
  patch('question-requiredness-contract', file,
    '  readonly initialAnswer?: string | undefined;',
    '  readonly initialAnswer?: string | undefined;\n  readonly required?: boolean | undefined;')
  patch('question-custom-exact-string', file,
    '  const trimmed = value.trim();\n  return trimmed.length > 0 ? trimmed : null;',
    '  return value.length > 0 ? value : null;')
  patch('question-optional-explicit-empty', file,
    '      : question.initialAnswer !== undefined',
    '      : question.initialAnswer !== undefined || question.required === false')
  patch('question-own-drafts-and-duplicate-ids', file,
    '  for (const question of questions) {\n' +
    '    const answer = resolvePendingUserInputAnswer(question, draftAnswers[question.id]);\n' +
    '    if (answer === null) {\n      return null;\n    }',
    '  const seen = new Set<string>();\n' +
    '  for (const question of questions) {\n' +
    '    if (seen.has(question.id)) return null;\n' +
    '    seen.add(question.id);\n' +
    '    const answer = resolvePendingUserInputAnswer(question,\n' +
    '      Object.hasOwn(draftAnswers, question.id) ? draftAnswers[question.id] : undefined);\n' +
    '    if (answer === null) {\n      if (question.required === false) continue;\n      return null;\n    }')
}
