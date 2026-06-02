import { LANGS } from "@/scripts/languages.ts"

export type SubtitleSegment = {
  start: number
  end: number
  text: string
  words?: SubtitleWord[]
}

export type SubtitleWord = {
  start: number
  end: number
  text: string
}

export function formatSrtTime(seconds: number): string {
  const c = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const h = Math.floor(c / 3600)
  const m = Math.floor((c % 3600) / 60)
  const s = Math.floor(c % 60)
  const ms = Math.floor((c - Math.floor(c)) * 1000)
  const p = (n: number, l = 2) => String(n).padStart(l, "0")
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`
}

export function formatClock(seconds: number): string {
  const c = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const m = Math.floor(c / 60)
  const s = Math.floor(c % 60)
  const cs = Math.round((c - Math.floor(c)) * 100)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${m}:${p(s)}.${p(cs)}`
}

export function parseClock(value: string): number | null {
  const match = String(value)
    .trim()
    .match(/^(\d+):(\d{1,2})(?:[.,](\d{1,3}))?$/)
  if (!match) return null
  const m = Number(match[1])
  const s = Number(match[2])
  const frac = match[3] ? Number(`0.${match[3]}`) : 0
  return m * 60 + s + frac
}

function normalizedRange(chunk: any, index: number) {
  const range = Array.isArray(chunk?.timestamp)
    ? chunk.timestamp
    : [index * 2, index * 2 + 2]
  const start = Number.isFinite(range[0]) ? range[0] : index * 2
  const end = Number.isFinite(range[1]) ? range[1] : start + 2
  return {
    start,
    end: Math.max(start + 0.08, end),
  }
}

function normalizeWordChunk(chunk: any, index: number): SubtitleWord | null {
  const text = String(chunk?.text || "").trim()
  if (!text) return null
  const { start, end } = normalizedRange(chunk, index)
  return { start, end, text }
}

function isWordLevelChunks(chunks: any[]) {
  const textChunks = chunks
    .map((chunk) => String(chunk?.text || "").trim())
    .filter(Boolean)
  if (textChunks.length < 2) return false
  const singleWordChunks = textChunks.filter((text) => !/\s/.test(text)).length
  return singleWordChunks / textChunks.length > 0.82
}

function wordsText(words: SubtitleWord[]) {
  return words.reduce((text, word) => appendWordText(text, word.text), "").trim()
}

function appendWordText(text: string, word: string) {
  if (!text) return word
  if (shouldJoinWithoutSpace(text, word)) return `${text}${word}`
  return `${text} ${word}`
}

function shouldJoinWithoutSpace(previous: string, next: string) {
  const cjk = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/
  return (
    /^[,.;:!?%\)\]\}\u2026]/.test(next) ||
    /[(\[\{]$/.test(previous) ||
    (cjk.test(previous.at(-1) || "") && cjk.test(next.charAt(0)))
  )
}

function tokenizeSubtitleText(text: string) {
  if (/\s/.test(text)) return text.split(/\s+/).filter(Boolean)
  if (/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(text))
    return Array.from(text)
  return text ? [text] : []
}

function buildWordSegment(words: SubtitleWord[]): SubtitleSegment {
  const start = words[0]?.start || 0
  const end = words[words.length - 1]?.end || start + 2
  return {
    start,
    end: Math.max(start + 0.35, end),
    text: wordsText(words),
    words,
  }
}

function normalizeWordLevelSegments(chunks: any[]): SubtitleSegment[] {
  const words = chunks
    .map((chunk, index) => normalizeWordChunk(chunk, index))
    .filter((word): word is SubtitleWord => !!word)
    .sort((a, b) => a.start - b.start)

  const segments: SubtitleSegment[] = []
  let line: SubtitleWord[] = []
  const flush = () => {
    if (!line.length) return
    segments.push(buildWordSegment(line))
    line = []
  }

  words.forEach((word) => {
    if (line.length) {
      const nextText = wordsText([...line, word])
      const nextDuration = word.end - line[0].start
      const shouldBreak =
        line.length >= 8 || nextText.length > 46 || nextDuration > 5.2
      if (shouldBreak) flush()
    }

    line.push(word)

    const text = wordsText(line)
    const duration = line[line.length - 1].end - line[0].start
    if (
      /[.!?\u2026]$/.test(word.text) &&
      line.length >= 3 &&
      duration >= 1.1 &&
      text.length >= 18
    )
      flush()
  })

  flush()
  return segments
}

export function estimatedWordsForSegment(segment: SubtitleSegment): SubtitleWord[] {
  const text = String(segment.text || "").trim()
  if (!text) return []

  const textWords = tokenizeSubtitleText(text)
  const storedWords =
    Array.isArray(segment.words) && segment.words.length ? segment.words : []
  if (
    storedWords.length &&
    wordsText(storedWords).replace(/\s+/g, " ") === text.replace(/\s+/g, " ")
  ) {
    return storedWords
  }

  const start = Number.isFinite(segment.start) ? segment.start : 0
  const end = Math.max(
    start + 0.35,
    Number.isFinite(segment.end) ? segment.end : start + 2,
  )
  const duration = end - start
  const totalWeight = textWords.reduce(
    (sum, word) => sum + Math.max(1, word.replace(/[^\p{L}\p{N}]/gu, "").length),
    0,
  )
  let cursor = start

  return textWords.map((word, index) => {
    const weight = Math.max(1, word.replace(/[^\p{L}\p{N}]/gu, "").length)
    const isLast = index === textWords.length - 1
    const wordEnd = isLast ? end : cursor + (duration * weight) / totalWeight
    const result = {
      start: cursor,
      end: Math.max(cursor + 0.05, wordEnd),
      text: word,
    }
    cursor = result.end
    return result
  })
}

export function normalizeSegments(output: any): SubtitleSegment[] {
  if (!output || !Array.isArray(output.chunks)) {
    const text = output?.text?.trim()
    return text ? [{ start: 0, end: 6, text }] : []
  }
  if (isWordLevelChunks(output.chunks)) return normalizeWordLevelSegments(output.chunks)

  return output.chunks
    .map((chunk: any, index: number) => {
      const { start, end } = normalizedRange(chunk, index)
      return {
        start,
        end: Math.max(start + 0.35, end),
        text: (chunk.text || "").trim(),
      }
    })
    .filter((s: SubtitleSegment) => s.text.length > 0)
}

export function buildSrt(segments: SubtitleSegment[]): string {
  return segments
    .map(
      (s, i) =>
        `${i + 1}\n${formatSrtTime(s.start)} --> ${formatSrtTime(s.end)}\n${s.text}`,
    )
    .join("\n\n")
}

export function normalizeLanguageCode(code: string): string {
  if (!code) return ""
  const short = String(code).toLowerCase().slice(0, 2)
  return short in LANGS ? short : ""
}
