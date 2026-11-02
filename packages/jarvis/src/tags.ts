/**
 * The 13 expression tags OmniVoice supports (from omnivoice/models/omnivoice.py `_NONVERBAL_PATTERN`).
 * Jarvis may write only these. Any other bracketed token is removed before display.
 */
export const TAGS = [
  "laughter",
  "sigh",
  "confirmation-en",
  "question-en",
  "question-ah",
  "question-oh",
  "question-ei",
  "question-yi",
  "surprise-ah",
  "surprise-oh",
  "surprise-wa",
  "surprise-yo",
  "dissatisfaction-hnn",
] as const

export type Tag = (typeof TAGS)[number]

const TAG_SET = new Set<string>(TAGS)
const BRACKET = /\[([a-zA-Z][a-zA-Z0-9-]{0,30})\]/g

export const TAG_PATTERN = new RegExp(`\\[(${TAGS.join("|")})\\]`)

/** Keep supported tags (at most one per reply), drop every other `[word]` token. Reports what it dropped. */
export function sanitizeTags(text: string): { text: string; tags: Tag[]; dropped: string[] } {
  const dropped: string[] = []
  const tags: Tag[] = []
  let out = text.replace(BRACKET, (m, name: string) => {
    const key = name.toLowerCase()
    if (!TAG_SET.has(key)) {
      dropped.push(m)
      return ""
    }
    if (tags.length >= 1) {
      dropped.push(m)
      return ""
    }
    tags.push(key as Tag)
    return `[${key}]`
  })
  out = out.replace(/[ \t]{2,}/g, " ").replace(/ +([,.!?])/g, "$1").trim()
  return { text: out, tags, dropped }
}

/** Never tag code, paths or quoted tool output: strip tags that sit inside backticks. */
export function stripTagsInCode(text: string): string {
  return text.replace(/`[^`]*`/g, (code) => code.replace(new RegExp(TAG_PATTERN.source, "g"), ""))
}

export function stripAllTags(text: string): string {
  return text.replace(new RegExp(TAG_PATTERN.source, "g"), "").replace(/[ \t]{2,}/g, " ").trim()
}
