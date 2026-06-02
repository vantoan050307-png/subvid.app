import {
  captionStyleForTrack,
  FONT_STACKS,
  hexToRgba,
} from "@/scripts/subtitleStyle.ts"
import { estimatedWordsForSegment } from "@/scripts/subtitles.ts"

export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines = []
  for (const paragraph of text.split(/\n+/)) {
    const words = paragraph.split(/\s+/)
    let line = ""
    for (const word of words) {
      const test = line ? `${line} ${word}` : word
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line)
        line = word
      } else {
        line = test
      }
    }
    if (line) lines.push(line)
  }
  return lines
}

function wrapWords(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  words: Array<{ start: number; end: number; text: string }>,
  maxWidth: number,
) {
  const spaceWidth = ctx.measureText(" ").width
  const lines: Array<{
    words: Array<{ start: number; end: number; text: string; width: number }>
    width: number
  }> = []
  let line: Array<{ start: number; end: number; text: string; width: number }> = []
  let lineWidth = 0

  words.forEach((word) => {
    const width = ctx.measureText(word.text).width
    const nextWidth = line.length ? lineWidth + spaceWidth + width : width
    if (line.length && nextWidth > maxWidth) {
      lines.push({ words: line, width: lineWidth })
      line = []
      lineWidth = 0
    }
    lineWidth = line.length ? lineWidth + spaceWidth + width : width
    line.push({ ...word, width })
  })

  if (line.length) lines.push({ words: line, width: lineWidth })
  return lines
}

function renderTracks(segments: any[]) {
  if (!Array.isArray(segments[0])) {
    if (segments[0]?.segments) return segments
    return [{ role: "default", segments }]
  }
  return segments.map((track) => ({ role: "default", segments: track }))
}

function drawSubtitleBackground(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  blockW: number,
  lineHeight: number,
  fontSize: number,
  padY: number,
  color: string,
) {
  const boxH = lineHeight + padY
  const boxX = x - blockW / 2
  const boxY = y - fontSize - padY / 2
  const r = fontSize * 0.18
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(boxX + r, boxY)
  ctx.arcTo(boxX + blockW, boxY, boxX + blockW, boxY + boxH, r)
  ctx.arcTo(boxX + blockW, boxY + boxH, boxX, boxY + boxH, r)
  ctx.arcTo(boxX, boxY + boxH, boxX, boxY, r)
  ctx.arcTo(boxX, boxY, boxX + blockW, boxY, r)
  ctx.closePath()
  ctx.fill()
}

function drawSubtitleBox(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  seg: any,
  role: string,
  lang: string,
  time: number,
  w: number,
  h: number,
) {
  const text = String(seg?.text || "")
  if (!text.trim()) return

  const c = captionStyleForTrack(role, lang)
  const fontSize = Math.round(h * 0.052 * c.size)
  ctx.font = `${c.italic ? "italic " : ""}${c.weight} ${fontSize}px ${
    FONT_STACKS[c.font] || FONT_STACKS.sans
  }`
  const align = c.align === "left" || c.align === "right" ? c.align : "center"
  ctx.textAlign = align
  ctx.textBaseline = "alphabetic"

  const wordHighlight = !!c.wordHighlight
  const wordLines = wordHighlight
    ? wrapWords(ctx, estimatedWordsForSegment(seg), w * 0.82)
    : []
  const textLines = wordHighlight
    ? wordLines.map((line) => line.words.map((word) => word.text).join(" "))
    : wrapText(ctx as CanvasRenderingContext2D, text.trim(), w * 0.82)
  const lineHeight = fontSize * 1.28
  const padX = fontSize * 0.5
  const padY = fontSize * 0.3
  const blockH = textLines.length * lineHeight
  const blockW =
    Math.max(
      ...(
        wordHighlight
          ? wordLines.map((line) => line.width)
          : textLines.map((line) => ctx.measureText(line).width)
      ),
    ) +
    padX * 2
  let x = w / 2
  let y: number
  if (c.position === "custom") {
    x = w * (Math.max(0, Math.min(100, Number(c.customX) || 50)) / 100)
    y =
      h * (Math.max(0, Math.min(100, Number(c.customY) || 50)) / 100) -
      blockH / 2 +
      fontSize
  } else if (c.position === "top") {
    y = h * 0.08 + fontSize
  } else if (c.position === "middle") {
    y = (h - blockH) / 2 + fontSize
  } else {
    y = h - h * 0.06 - (textLines.length - 1) * lineHeight
  }

  const textX =
    align === "left" ? x - blockW / 2 + padX : align === "right" ? x + blockW / 2 - padX : x

  textLines.forEach((line, lineIndex) => {
    if (c.bgEnabled) {
      drawSubtitleBackground(
        ctx,
        x,
        y,
        blockW,
        lineHeight,
        fontSize,
        padY,
        hexToRgba(c.bgColor, c.bgOpacity),
      )
    }

    if (wordHighlight) {
      drawHighlightedWords(
        ctx,
        wordLines[lineIndex],
        align,
        textX,
        x,
        blockW,
        padX,
        y,
        time,
        c,
        fontSize,
      )
      y += lineHeight
      return
    }

    if (!c.bgEnabled && c.outline) {
      ctx.lineWidth = Math.max(2, fontSize * 0.14)
      ctx.strokeStyle = "rgba(0, 0, 0, 0.85)"
      ctx.lineJoin = "round"
      ctx.miterLimit = 2
      ctx.strokeText(line, textX, y)
    } else if (!c.bgEnabled) {
      ctx.shadowColor = "rgba(0, 0, 0, 0.8)"
      ctx.shadowBlur = fontSize * 0.25
      ctx.shadowOffsetY = fontSize * 0.04
    }

    ctx.fillStyle = c.color
    ctx.fillText(line, textX, y)
    ctx.shadowColor = "transparent"
    ctx.shadowBlur = 0
    ctx.shadowOffsetY = 0
    y += lineHeight
  })
}

function drawHighlightedWords(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  line:
    | {
        words: Array<{ start: number; end: number; text: string; width: number }>
        width: number
      }
    | undefined,
  align: "left" | "right" | "center",
  textX: number,
  centerX: number,
  blockW: number,
  padX: number,
  y: number,
  time: number,
  c: any,
  fontSize: number,
) {
  if (!line?.words.length) return

  const spaceWidth = ctx.measureText(" ").width
  let cursor =
    align === "left"
      ? textX
      : align === "right"
        ? centerX + blockW / 2 - padX - line.width
        : centerX - line.width / 2

  ctx.textAlign = "left"
  line.words.forEach((word) => {
    const spoken = time >= word.start
    const alpha = spoken ? 1 : 0.38
    ctx.globalAlpha = alpha

    if (!c.bgEnabled && c.outline) {
      ctx.lineWidth = Math.max(2, fontSize * 0.14)
      ctx.strokeStyle = "rgba(0, 0, 0, 0.85)"
      ctx.lineJoin = "round"
      ctx.miterLimit = 2
      ctx.strokeText(word.text, cursor, y)
    } else if (!c.bgEnabled) {
      ctx.shadowColor = "rgba(0, 0, 0, 0.8)"
      ctx.shadowBlur = fontSize * 0.25
      ctx.shadowOffsetY = fontSize * 0.04
    }

    ctx.fillStyle = spoken ? "#ffffff" : c.color
    ctx.fillText(word.text, cursor, y)
    ctx.shadowColor = "transparent"
    ctx.shadowBlur = 0
    ctx.shadowOffsetY = 0
    ctx.globalAlpha = 1
    cursor += word.width + spaceWidth
  })
  ctx.textAlign = align
}

export function drawSubtitlesAt(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  time: number,
  w: number,
  h: number,
  segments: any[],
) {
  renderTracks(segments).forEach((track) => {
    const seg = track.segments.find((s: any) => time >= s.start && time <= s.end)
    if (!seg?.text?.trim()) return
    drawSubtitleBox(ctx, seg, track.role || "default", track.lang || "", time, w, h)
  })
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  w: number,
  h: number,
  segments: any[],
) {
  ctx.drawImage(video, 0, 0, w, h)
  drawSubtitlesAt(ctx, video.currentTime, w, h, segments)
}
