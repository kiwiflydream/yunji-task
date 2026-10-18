const VARIABLE_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g

export const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export class UnknownVariableError extends Error {
  constructor(readonly names: string[]) {
    super(`unknown variable(s): ${names.join(', ')}`)
  }
}

/** Variable names (without dots) referenced as `{{NAME}}` in the given strings. */
export function referencedVariables(...inputs: string[]): string[] {
  const names = new Set<string>()
  for (const input of inputs) {
    for (const m of input.matchAll(VARIABLE_RE)) {
      if (!m[1].includes('.')) names.add(m[1])
    }
  }
  return [...names]
}

/**
 * Replace `{{key}}` placeholders. Unknown keys throw so a typo never silently
 * sends a literal placeholder downstream.
 */
export function renderTemplate(
  input: string,
  values: Record<string, string>,
  escape: (value: string) => string = (v) => v,
): string {
  const missing = new Set<string>()
  const out = input.replace(VARIABLE_RE, (_, key: string) => {
    if (!Object.hasOwn(values, key)) {
      missing.add(key)
      return ''
    }
    return escape(values[key])
  })
  if (missing.size > 0) throw new UnknownVariableError([...missing])
  return out
}

/** Escape a value for embedding inside a JSON string literal. */
export function jsonStringEscape(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

/** Length of the longest pattern prefix at the end of text, in linear time. */
function trailingPrefix(text: string, pattern: string): number {
  const failure = new Uint32Array(pattern.length)
  for (let i = 1, matched = 0; i < pattern.length; i++) {
    while (matched > 0 && pattern[i] !== pattern[matched]) matched = failure[matched - 1]
    if (pattern[i] === pattern[matched]) matched++
    failure[i] = matched
  }
  let matched = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    while (matched > 0 && (matched === pattern.length || char !== pattern[matched])) matched = failure[matched - 1]
    if (char === pattern[matched]) matched++
  }
  return matched
}

/** Redact values and JSON escapes; a truncated log also hides partial values at its tail. */
export function redact(text: string, secrets: string[], truncated = false): string {
  const patterns = [...new Set(secrets.filter((secret) => secret.length >= 4)
    .flatMap((secret) => [secret, jsonStringEscape(secret)]))]
    .sort((a, b) => b.length - a.length)
  // The response reader may already have cut the value off. Full-match replacement
  // alone cannot protect that suffix, even if it runs before log truncation.
  const tail = truncated ? patterns.reduce((longest, pattern) => Math.max(longest, trailingPrefix(text, pattern)), 0) : 0
  let out = tail > 0 ? text.slice(0, -tail) + '***' : text
  for (const pattern of patterns) out = out.split(pattern).join('***')
  return out
}
