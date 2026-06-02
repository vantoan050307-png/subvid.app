import {
  builtInBackendLabel,
  hasBuiltInTranslationSupport,
  resolveTranslationBackend,
  translateCuesBuiltIn,
} from "./builtInTranslate.ts"
import { $, $$ } from "./dom.ts"
import { createDownloadsController } from "./downloads.ts"
import { createAudioService } from "./media/audio.ts"
import { I18N, langName, tt } from "./i18n.ts"
import { ASR_MODEL, LANGS, TRANSLATION_MODEL } from "./languages.ts"
import {
  buildSrt,
  formatClock,
  normalizeLanguageCode,
  normalizeSegments,
  parseClock,
} from "./subtitles.ts"
import { createTransformersClient } from "./transformersClient.ts"
import { ui } from "./ui.ts"

// ── Subtitle styling ──
const FONT_STACKS = {
  sans: '"Outfit", "Segoe UI", system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  rounded: '"Quicksand", "Trebuchet MS", system-ui, sans-serif',
  condensed: '"Arial Narrow", "Roboto Condensed", system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, "SF Mono", monospace',
}

// Visual presets. `position` is intentionally omitted so switching presets
// never moves the captions the user already placed.
const CAPTION_PRESETS = [
  {
    id: "default",
    name: "Default",
    s: {
      font: "sans",
      size: 1,
      color: "#ffffff",
      weight: 600,
      bgEnabled: true,
      bgColor: "#06080b",
      bgOpacity: 0.84,
      outline: false,
    },
  },
  {
    id: "clean",
    name: "Clean",
    s: {
      font: "sans",
      size: 1,
      color: "#ffffff",
      weight: 600,
      bgEnabled: false,
      bgColor: "#06080b",
      bgOpacity: 0.84,
      outline: true,
    },
  },
  {
    id: "bold",
    name: "Bold",
    s: {
      font: "sans",
      size: 1.12,
      color: "#ffffff",
      weight: 700,
      bgEnabled: true,
      bgColor: "#000000",
      bgOpacity: 1,
      outline: false,
    },
  },
  {
    id: "pop",
    name: "Pop",
    s: {
      font: "rounded",
      size: 1.06,
      color: "#fde047",
      weight: 700,
      bgEnabled: false,
      bgColor: "#000000",
      bgOpacity: 0.84,
      outline: true,
    },
  },
  {
    id: "neon",
    name: "Neon",
    s: {
      font: "sans",
      size: 1,
      color: "#b8f060",
      weight: 700,
      bgEnabled: true,
      bgColor: "#06080b",
      bgOpacity: 0.55,
      outline: false,
    },
  },
  {
    id: "classic",
    name: "Classic",
    s: {
      font: "serif",
      size: 1,
      color: "#ffffff",
      weight: 600,
      bgEnabled: false,
      bgColor: "#06080b",
      bgOpacity: 0.84,
      outline: true,
    },
  },
  {
    id: "terminal",
    name: "Terminal",
    s: {
      font: "mono",
      size: 0.92,
      color: "#ffffff",
      weight: 600,
      bgEnabled: true,
      bgColor: "#0a0d12",
      bgOpacity: 0.9,
      outline: false,
    },
  },
]

const captionStyle = {
  font: "sans",
  size: 1,
  color: "#ffffff",
  weight: 600,
  bgEnabled: true,
  bgColor: "#06080b",
  bgOpacity: 0.84,
  outline: false,
  position: "bottom",
}
let activePresetId = "default"

const {
  downloads,
  renderDownloads,
  updateDownloadStatus,
  makeTransformersTracker,
  fetchWithProgress,
  refreshClearModelsUI,
  clearLocalModels,
} = createDownloadsController({
  ui,
  tt,
  prettifyBytes,
  hasBuiltInTranslationSupport,
})

// ── State ──
let selectedVideoFile = null
let videoObjectUrl = ""
let detectedLang = ""
let baseSegments = []
let segmentsByLang = {}
let orderedLangs = []
let activeLang = ""

let asrReady = false
let translationReady = false
/** @type {'prompt' | 'nllb' | null} */
let activeTranslationBackend = null
let dragDepth = 0
let exporting = false
let progressRaf = 0

const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator

const asrTracker = makeTransformersTracker("asr")
const translationTracker = makeTransformersTracker("translation")
const transformersClient = createTransformersClient({
  onProgress(key, payload) {
    if (key === "asr") asrTracker(payload)
    else if (key === "translation") translationTracker(payload)
  },
})
const { ensureFfmpeg, extractAudioBuffer } = createAudioService({
  tt,
  fetchWithProgress,
  updateDownloadStatus,
  setStatus,
  setProgress,
  applyProgress,
  setIndeterminate,
  startProgressCreep,
  stopProgressCreep,
})

const currentSegments = () => segmentsByLang[activeLang] || []

// ── Undo / redo history ──
// Snapshots of the whole per-language segment map. Any edit (text, timings,
// add/delete, timeline drag) records the pre-change state so it can be undone
// and redone.
const HISTORY_LIMIT = 100
let undoStack = []
let redoStack = []
// Pre-edit snapshot captured when a text field gains focus, committed on blur
// only if the text actually changed (so a whole edit = one undo step).
let textEditSnapshot = null

function snapshotSegments() {
  // Capture the full editable state: per-language segments plus the language
  // list/selection, so adding or removing a language is undoable too.
  return JSON.stringify({ segmentsByLang, orderedLangs, activeLang })
}

function refreshHistoryButtons() {
  if (ui.undoBtn) ui.undoBtn.disabled = undoStack.length === 0
  if (ui.redoBtn) ui.redoBtn.disabled = redoStack.length === 0
}

function resetHistory() {
  undoStack = []
  redoStack = []
  refreshHistoryButtons()
}

// Record the state *before* a mutation. Call this right before changing
// segments; a new edit clears the redo branch.
function pushHistory(snapshotBefore) {
  undoStack.push(snapshotBefore)
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift()
  redoStack = []
  refreshHistoryButtons()
}

function restoreSnapshot(json) {
  const snap = JSON.parse(json)
  segmentsByLang = snap.segmentsByLang || {}
  orderedLangs = snap.orderedLangs || Object.keys(segmentsByLang)
  activeLang = snap.activeLang || orderedLangs[0] || ""
  if (!segmentsByLang[activeLang])
    activeLang = orderedLangs[0] || Object.keys(segmentsByLang)[0] || ""
  renderTabs() // rebuilds tabs + the "add language" select
  renderSegments() // also re-renders the timeline
  enableExports(true)
  updateCaption()
}

function undo() {
  if (!undoStack.length) return
  redoStack.push(snapshotSegments())
  restoreSnapshot(undoStack.pop())
  refreshHistoryButtons()
}

function redo() {
  if (!redoStack.length) return
  undoStack.push(snapshotSegments())
  restoreSnapshot(redoStack.pop())
  refreshHistoryButtons()
}

// ── Helpers ──
function setStatus(message, kind = "ok") {
  // Shown on the config stage while generating (the editor has no status line).
  ui.configStatus.textContent = message
  ui.configStatus.dataset.kind = kind
}

function setProgress(percent) {
  setIndeterminate(false)
  applyProgress(percent)
}

// Switch the bar to/from an indeterminate CSS animation. Used for opaque steps
// of unknown duration (audio extraction) so the bar keeps moving on the
// compositor thread instead of freezing when there's no real progress to show.
let progressIndeterminate = false
function setIndeterminate(on) {
  if (on) stopProgressCreep()
  progressIndeterminate = on
  ui.configProgressFill.classList.toggle("is-indeterminate", on)
  // The moving stripe is the cue; a numeric % would just sit there frozen.
  if (on) ui.configProgressPct.textContent = ""
}

// Directly paint a progress value without touching any running animation.
function applyProgress(percent) {
  if (progressIndeterminate) return
  const clamped = Math.max(0, Math.min(100, percent))
  ui.configProgressFill.style.width = `${clamped}%`
  ui.configProgressPct.textContent = `${Math.round(clamped)}%`
}

function stopProgressCreep() {
  if (progressRaf) {
    cancelAnimationFrame(progressRaf)
    progressRaf = 0
  }
}

// Smoothly creep from `from` toward `ceiling` (asymptotically, never quite
// reaching it) so an opaque step still shows continuous movement. `expected`
// is the rough duration in ms the step is expected to take.
function startProgressCreep(from, ceiling, expected) {
  stopProgressCreep()
  const start = performance.now()
  const span = ceiling - from
  const tick = (now) => {
    const t = (now - start) / Math.max(1, expected)
    const eased = 1 - Math.exp(-1.6 * t)
    applyProgress(from + span * eased)
    progressRaf = requestAnimationFrame(tick)
  }
  progressRaf = requestAnimationFrame(tick)
}

function prettifyBytes(bytes) {
  if (!bytes && bytes !== 0) return "-"
  const units = ["B", "KB", "MB", "GB"]
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function outputTarget(sourceLang) {
  const value = ui.outputLang.value
  if (!value || value === "same") return sourceLang
  return LANGS[value] ? value : sourceLang
}

function baseFileName() {
  return (
    (selectedVideoFile?.name || "subtitles")
      .replace(/\.[^/.]+$/, "")
      .replace(/[^a-zA-Z0-9-_]+/g, "-")
      .toLowerCase() || "subtitles"
  )
}

// ── Stage switching ──
function setStage(stage) {
  ui.stageUpload.hidden = stage !== "upload"
  ui.stageConfig.hidden = stage !== "config"
  ui.stageEditor.hidden = stage !== "editor"
  if (ui.statusDock) ui.statusDock.hidden = stage === "editor"
  if (stage === "editor") ui.downloadsPanel.hidden = true
}

// ── Lazy model loaders ──
async function ensureRecognizer() {
  if (asrReady) return
  updateDownloadStatus("asr", "downloading")
  await transformersClient.call("ensure-asr", {
    model: ASR_MODEL,
    webgpu: hasWebGPU,
  })
  asrReady = true
  updateDownloadStatus("asr", "ready")
}

function markTranslationBuiltIn(backend) {
  activeTranslationBackend = backend
  translationReady = true
  const item = downloads.translation
  item.readyNote = tt("downloads.translationBuiltin", {
    engine: builtInBackendLabel(),
  })
  item.total = 0
  item.loaded = 0
  updateDownloadStatus("translation", "ready")
}

async function ensureNllbTranslator() {
  if (translationReady && activeTranslationBackend === "nllb") return
  activeTranslationBackend = "nllb"
  updateDownloadStatus("translation", "downloading")
  downloads.translation.readyNote = ""
  await transformersClient.call("ensure-translation", {
    model: TRANSLATION_MODEL,
  })
  translationReady = true
  updateDownloadStatus("translation", "ready")
}

async function ensureTranslation(sourceLang, targetLang) {
  const backend = await resolveTranslationBackend(sourceLang, targetLang)
  if (backend !== "nllb") {
    updateDownloadStatus("translation", "downloading")
    downloads.translation.readyNote = ""
    return backend
  }
  await ensureNllbTranslator()
  return "nllb"
}

async function preloadAssetsInBackground() {
  await Promise.allSettled([
    ensureFfmpeg().catch((e) => {
      console.error(e)
      updateDownloadStatus("ffmpeg", "error")
    }),
    ensureRecognizer().catch((e) => {
      console.error(e)
      updateDownloadStatus("asr", "error")
    }),
  ])
}

// ── Translation ──
// Chrome + en/es/ja: Gemini Nano (Prompt API). Everything else → NLLB in the worker.
async function translateSegments(segments, sourceLang, targetLang) {
  if (!segments.length || sourceLang === targetLang)
    return segments.map((s) => ({ ...s }))
  if (!LANGS[sourceLang] || !LANGS[targetLang])
    return segments.map((s) => ({ ...s }))
  setStatus(tt("steps.translatingTo", { lang: langName(targetLang) }), "busy")

  const cues = segments.map((s) => ({
    text: s.text,
    start: s.start,
    end: s.end,
  }))
  const texts = segments.map((s) => s.text)
  const backend = await ensureTranslation(sourceLang, targetLang)

  let translatedTexts
  if (backend === "nllb") {
    const translated = await transformersClient.call("translate", {
      texts,
      src: LANGS[sourceLang].nllb,
      tgt: LANGS[targetLang].nllb,
    })
    const normalized = Array.isArray(translated) ? translated : [translated]
    translatedTexts = segments.map((s, i) =>
      (
        normalized[i]?.translation_text ||
        normalized[i]?.generated_text ||
        s.text
      ).trim(),
    )
  } else {
    const onModelProgress = (ratio) => {
      downloads.translation.progress = Math.round(ratio * 100)
      renderDownloads()
    }
    try {
      translatedTexts = await translateCuesBuiltIn(cues, sourceLang, targetLang, {
        onProgress: onModelProgress,
        sourceLabel: LANGS[sourceLang].label,
        targetLabel: LANGS[targetLang].label,
      })
    } catch (err) {
      console.warn("[translate] built-in failed, falling back to NLLB", err)
      await ensureNllbTranslator()
      const translated = await transformersClient.call("translate", {
        texts,
        src: LANGS[sourceLang].nllb,
        tgt: LANGS[targetLang].nllb,
      })
      const normalized = Array.isArray(translated) ? translated : [translated]
      translatedTexts = segments.map((s, i) =>
        (
          normalized[i]?.translation_text ||
          normalized[i]?.generated_text ||
          s.text
        ).trim(),
      )
    }
    markTranslationBuiltIn(backend)
  }

  return segments.map((s, i) => ({
    ...s,
    text: (translatedTexts[i] || s.text).trim(),
  }))
}

// ── Generate flow ──
async function generate() {
  if (!selectedVideoFile || exporting) return
  ui.transcribeBtn.disabled = true
  ui.downloadVideoBtn.disabled = true
  ui.downloadSrtBtn.disabled = true
  ui.configError.hidden = true
  ui.configError.textContent = ""
  ui.configProgress.hidden = false
  setStatus(tt("steps.preparing"), "busy")
  setProgress(2)
  try {
    const audio = await extractAudioBuffer(selectedVideoFile)
    setStatus(tt("steps.loadingSpeech"), "busy")
    // On the first run the Whisper model is downloaded; mirror that real
    // byte progress onto 38%→48%. When it's already cached the download is
    // instant, so fall back to a gentle creep for the (opaque) warm-up.
    startProgressCreep(38, 48, 8000)
    const asrMonitor = setInterval(() => {
      const d = downloads.asr
      if (d.state === "downloading" && d.total) {
        stopProgressCreep()
        const ratio = Math.min(1, d.progress / 100)
        applyProgress(38 + ratio * 10)
        const meta = prettifyBytes(d.loaded) + " / " + prettifyBytes(d.total)
        setStatus(`Step 4/5 · Downloading speech model… ${meta}`, "busy")
      }
    }, 200)
    try {
      await ensureRecognizer()
    } finally {
      clearInterval(asrMonitor)
      stopProgressCreep()
    }
    setProgress(48)

    // Whisper processes the audio in ~20s chunks (chunk_length 30s minus the
    // two 5s overlaps). We know the total up front, so `chunk_callback` lets
    // us advance the bar one real chunk at a time instead of one opaque jump.
    const TR_START = 48
    const TR_END = 90
    const audioSeconds = audio.length / 16000
    const chunkSeconds = 30 - 2 * 5
    const totalChunks = Math.max(1, Math.ceil(audioSeconds / chunkSeconds))
    const chunkSpan = (TR_END - TR_START) / totalChunks
    let chunksDone = 0
    let lastChunkAt = performance.now()
    // Rough first estimate; refined with the real timing of each finished chunk.
    let perChunkMs = Math.max(2000, (audioSeconds / totalChunks) * 900)

    const transcribeStatus = () => {
      setStatus(tt("steps.transcribing"), "busy")
    }

    transcribeStatus()
    applyProgress(TR_START)
    // Creep across the first chunk until its callback lands.
    startProgressCreep(TR_START, TR_START + chunkSpan, perChunkMs)

    // The worker streams a "chunk" message after each ~20s window it finishes.
    transformersClient.setChunkHandler(() => {
      const now = performance.now()
      perChunkMs = Math.max(500, now - lastChunkAt)
      lastChunkAt = now
      chunksDone = Math.min(totalChunks, chunksDone + 1)
      const floor = Math.min(TR_END, TR_START + chunksDone * chunkSpan)
      const ceiling = Math.min(TR_END, floor + chunkSpan)
      transcribeStatus()
      stopProgressCreep()
      applyProgress(floor)
      if (chunksDone < totalChunks)
        startProgressCreep(floor, ceiling, perChunkMs)
    })

    let output
    try {
      // Transfer the audio buffer so it's moved (not copied) to the worker.
      output = await transformersClient.call(
        "transcribe",
        { audio, language: ui.inputLang.value || null },
        [audio.buffer],
      )
    } finally {
      transformersClient.setChunkHandler(null)
    }
    stopProgressCreep()
    setProgress(TR_END)

    setStatus(tt("steps.buildingLines"), "busy")
    applyProgress(92)
    detectedLang =
      normalizeLanguageCode(output?.language) ||
      normalizeLanguageCode(ui.inputLang.value) ||
      "en"

    baseSegments = normalizeSegments(output)
    if (!baseSegments.length)
      throw new Error(tt("noSpeech"))

    const target = outputTarget(detectedLang)
    const targets = [detectedLang]
    if (target !== detectedLang && !targets.includes(target))
      targets.push(target)

    // Translation (if any) gets the final 92%→100% stretch, split per language.
    const TX_START = 92
    const TX_SPAN = 100 - TX_START
    segmentsByLang = {}
    let done = 0
    for (const lang of targets) {
      if (lang === detectedLang) {
        segmentsByLang[lang] = baseSegments.map((s) => ({ ...s }))
      } else {
        startProgressCreep(
          TX_START + (done / targets.length) * TX_SPAN,
          TX_START + ((done + 1) / targets.length) * TX_SPAN,
          6000,
        )
        segmentsByLang[lang] = await translateSegments(
          baseSegments,
          detectedLang,
          lang,
        )
        stopProgressCreep()
      }
      done += 1
      setProgress(TX_START + (done / targets.length) * TX_SPAN)
    }

    orderedLangs = targets
    activeLang = target
    renderTabs()
    renderSegments()
    enableExports(true)
    ui.addSegBtn.disabled = false
    // The freshly generated transcription is the baseline; nothing to undo to.
    resetHistory()
    setProgress(100)
    setStatus(
      tt("ready", { n: baseSegments.length, count: targets.length }),
      "ok",
    )
    setStage("editor")
    updateCaption()
    ui.configProgress.hidden = true
  } catch (error) {
    console.error(error)
    const message = error?.message || tt("genError")
    setStatus(message, "error")
    setProgress(0)
    ui.configError.textContent = message
    ui.configError.hidden = false
    ui.configProgress.hidden = true
  } finally {
    ui.transcribeBtn.disabled = false
  }
}

function enableExports(on) {
  const ready = on && currentSegments().length > 0
  ui.downloadSrtBtn.disabled = !ready
  ui.downloadVideoBtn.disabled = !ready
}

// ── Rendering: language selects, tabs, segments ──
function buildLangSelects() {
  ui.inputLang.innerHTML = `<option value="">${tt("detectAuto")}</option>`
  ui.outputLang.innerHTML = `<option value="same">${tt("sameAsAudio")}</option>`
  Object.keys(LANGS).forEach((code) => {
    const inOpt = document.createElement("option")
    inOpt.value = code
    inOpt.textContent = langName(code)
    ui.inputLang.appendChild(inOpt)

    const outOpt = document.createElement("option")
    outOpt.value = code
    outOpt.textContent = langName(code)
    ui.outputLang.appendChild(outOpt)
  })
}

function renderTabs() {
  ui.langTabs.innerHTML = ""
  orderedLangs.forEach((lang) => {
    const tab = document.createElement("button")
    tab.type = "button"
    tab.className = `tab${lang === activeLang ? " is-active" : ""}`
    tab.textContent = langName(lang)
    tab.addEventListener("click", () => {
      if (activeLang === lang) return
      activeLang = lang
      renderTabs()
      renderSegments()
      enableExports(true)
      updateCaption()
    })
    ui.langTabs.appendChild(tab)
  })
  populateAddLang()
}

// ── Add a subtitle language from the editor (translate without going back) ──
let translatingLang = ""

function populateAddLang() {
  if (!ui.langAddSelect) return
  const remaining = Object.entries(LANGS).filter(
    ([code]) => !orderedLangs.includes(code),
  )
  ui.langAddSelect.innerHTML = `<option value="">${tt("addLangOption")}</option>`
  remaining.forEach(([code]) => {
    const opt = document.createElement("option")
    opt.value = code
    opt.textContent = langName(code)
    ui.langAddSelect.appendChild(opt)
  })
  ui.langAddSelect.value = ""
  ui.langAddSelect.disabled =
    !!translatingLang || orderedLangs.length === 0 || remaining.length === 0
}

function setLangAddStatus(message, kind = "ok") {
  if (!ui.langAddStatus) return
  ui.langAddStatus.textContent = message
  ui.langAddStatus.dataset.kind = kind
  ui.langAddStatus.hidden = !message
}

async function addLanguage(target) {
  if (translatingLang || !LANGS[target] || orderedLangs.includes(target)) return
  // Translate from the (possibly edited) source-language track so timings and
  // edits carry over, falling back to the original transcription.
  const source =
    detectedLang && LANGS[detectedLang] ? detectedLang : orderedLangs[0]
  const sourceSegs = segmentsByLang[source] || baseSegments
  if (!sourceSegs?.length) return

  translatingLang = target
  if (ui.langAddSelect) ui.langAddSelect.disabled = true
  setLangAddStatus(tt("translatingTo", { lang: langName(target) }), "busy")
  try {
    const translated = await translateSegments(sourceSegs, source, target)
    const before = snapshotSegments()
    segmentsByLang[target] = translated
    orderedLangs = [...orderedLangs, target]
    activeLang = target
    pushHistory(before)
    setLangAddStatus("", "ok")
    renderTabs()
    renderSegments()
    enableExports(true)
    updateCaption()
  } catch (error) {
    console.error(error)
    setLangAddStatus(tt("translationFailed"), "error")
  } finally {
    translatingLang = ""
    populateAddLang()
  }
}

function renderSegments() {
  const segments = currentSegments()
  ui.segList.innerHTML = ""
  if (!segments.length) {
    ui.segList.innerHTML = `<li class="seg-empty">${tt("segEmpty")}</li>`
    ui.segCount.textContent = ""
    renderTimeline()
    return
  }
  segments.forEach((seg, index) => {
    const li = document.createElement("li")
    li.className = "seg"
    li.dataset.index = String(index)
    li.innerHTML = `
      <div class="seg-row">
        <button class="seg-play" type="button" title="${tt("goTitle")}" aria-label="${tt("goAria")}">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M3 2l5 3.5L3 9V2z" fill="currentColor"/></svg>
        </button>
        <input class="t-input t-start" value="${formatClock(seg.start)}" aria-label="${tt("startAria")}" />
        <span class="t-sep">→</span>
        <input class="t-input t-end" value="${formatClock(seg.end)}" aria-label="${tt("endAria")}" />
        <button class="seg-del" type="button" title="${tt("delTitle")}" aria-label="${tt("delAria")}">✕</button>
      </div>
      <textarea class="seg-text" rows="2" spellcheck="false">${seg.text.replace(/</g, "&lt;")}</textarea>
    `
    ui.segList.appendChild(li)
  })
  ui.segCount.textContent = tt("segCount", { n: segments.length })
  renderTimeline()
}

// Event delegation for sidebar edits
ui.segList.addEventListener("input", (event) => {
  const li = event.target.closest(".seg")
  if (!li) return
  const index = Number(li.dataset.index)
  const seg = currentSegments()[index]
  if (!seg) return
  if (event.target.classList.contains("seg-text")) {
    seg.text = event.target.value
    updateCaption()
  }
})

ui.segList.addEventListener("change", (event) => {
  const li = event.target.closest(".seg")
  if (!li) return
  const index = Number(li.dataset.index)
  const seg = currentSegments()[index]
  if (!seg) return
  if (
    event.target.classList.contains("t-start") ||
    event.target.classList.contains("t-end")
  ) {
    const parsed = parseClock(event.target.value)
    if (parsed === null) {
      event.target.value = formatClock(
        event.target.classList.contains("t-start") ? seg.start : seg.end,
      )
      return
    }
    const before = snapshotSegments()
    if (event.target.classList.contains("t-start")) seg.start = parsed
    else seg.end = parsed
    if (seg.end <= seg.start) seg.end = seg.start + 0.5
    currentSegments().sort((a, b) => a.start - b.start)
    pushHistory(before)
    renderSegments()
    updateCaption()
  }
})

ui.segList.addEventListener("click", (event) => {
  const li = event.target.closest(".seg")
  if (!li) return
  const index = Number(li.dataset.index)
  const seg = currentSegments()[index]
  if (!seg) return
  if (event.target.closest(".seg-play")) {
    ui.video.currentTime = seg.start
    ui.video.play().catch(() => {})
  } else if (event.target.closest(".seg-del")) {
    const before = snapshotSegments()
    currentSegments().splice(index, 1)
    pushHistory(before)
    renderSegments()
    enableExports(true)
    updateCaption()
    return
  }
  // Selecting a line in the sidebar reveals + highlights it on the timeline.
  highlightSegment(index, { scrollTimeline: true })
})

// Editing a line moves the video to that moment.
ui.segList.addEventListener("focusin", (event) => {
  const li = event.target.closest(".seg")
  if (!li) return
  const isEditable =
    event.target.classList.contains("seg-text") ||
    event.target.classList.contains("t-input")
  if (!isEditable) return
  const index = Number(li.dataset.index)
  const seg = currentSegments()[index]
  if (!seg) return
  if (event.target.classList.contains("seg-text"))
    textEditSnapshot = snapshotSegments()
  if (Math.abs(ui.video.currentTime - seg.start) > 0.05)
    ui.video.currentTime = seg.start
  highlightSegment(index, { scrollTimeline: true })
})

// Commit a text edit as a single undo step when the field loses focus.
ui.segList.addEventListener("focusout", (event) => {
  if (!event.target.classList?.contains("seg-text")) return
  if (textEditSnapshot && snapshotSegments() !== textEditSnapshot)
    pushHistory(textEditSnapshot)
  textEditSnapshot = null
})

ui.addSegBtn.addEventListener("click", () => {
  const before = snapshotSegments()
  const segments = currentSegments()
  const t = ui.video.currentTime || 0
  segments.push({ start: t, end: t + 2, text: "" })
  segments.sort((a, b) => a.start - b.start)
  pushHistory(before)
  renderSegments()
  enableExports(true)
  const created = $(
    `.seg[data-index="${segments.findIndex((s) => s.start === t)}"] .seg-text`,
    ui.segList,
  )
  created?.focus()
})

// ── Timeline (video-editor style) ──
const TL_MIN_DUR = 0.3
let tlPxPerSec = 90
let tlDuration = 0
let tlDrag = null

function tlTotalDuration() {
  const segs = currentSegments()
  const segEnd = segs.length ? segs[segs.length - 1].end : 0
  return Math.max(tlDuration, segEnd, 1)
}

function renderTimeline() {
  if (!ui.timelineBlocks) return
  const segments = currentSegments()
  const dur = tlTotalDuration()
  ui.timelineTrack.style.width = `${dur * tlPxPerSec}px`

  // Ruler ticks — choose a step that keeps labels legible.
  let step = 1
  if (tlPxPerSec < 24) step = 15
  else if (tlPxPerSec < 45) step = 10
  else if (tlPxPerSec < 80) step = 5
  else if (tlPxPerSec < 140) step = 2
  else step = 1
  let ruler = ""
  for (let t = 0; t <= dur + 0.001; t += step) {
    const left = t * tlPxPerSec
    ruler += `<span class="tl-tick" style="left:${left}px"><i></i><b>${formatClock(t)}</b></span>`
  }
  ui.timelineRuler.innerHTML = ruler

  // Subtitle blocks
  ui.timelineBlocks.innerHTML = ""
  segments.forEach((seg, index) => {
    const block = document.createElement("div")
    block.className = "tl-block"
    block.dataset.index = String(index)
    block.style.left = `${seg.start * tlPxPerSec}px`
    block.style.width = `${Math.max(TL_MIN_DUR, seg.end - seg.start) * tlPxPerSec}px`
    block.innerHTML = `
      <span class="tl-handle tl-handle-l" data-edge="start"></span>
      <span class="tl-block-label">${(seg.text || "—").replace(/</g, "&lt;")}</span>
      <span class="tl-handle tl-handle-r" data-edge="end"></span>
    `
    ui.timelineBlocks.appendChild(block)
  })
  updateTimelinePlayhead()
}

function updateTimelinePlayhead(timeOverride) {
  if (!ui.timelinePlayhead) return
  const t = timeOverride ?? ui.video.currentTime ?? 0
  const x = t * tlPxPerSec
  // transform (vs left) keeps the move on the compositor for sub-pixel smoothness.
  ui.timelinePlayhead.style.transform = `translate3d(${x}px,0,0)`
  if (ui.tlClock)
    ui.tlClock.textContent = `${formatClock(t)} / ${formatClock(tlTotalDuration())}`
  // Keep the playhead in view while playing.
  if (!ui.video.paused && ui.timelineScroll) {
    const view = ui.timelineScroll
    if (
      x < view.scrollLeft + 60 ||
      x > view.scrollLeft + view.clientWidth - 60
    ) {
      view.scrollLeft = x - view.clientWidth * 0.4
    }
  }
}

function setTimelineActive(idx) {
  if (!ui.timelineBlocks) return
  $$(".tl-block.is-active", ui.timelineBlocks).forEach((el) =>
    el.classList.remove("is-active"),
  )
  if (idx >= 0) {
    $(`.tl-block[data-index="${idx}"]`, ui.timelineBlocks)?.classList.add(
      "is-active",
    )
  }
}

// ── Playhead scrubbing ──
// Dragging anywhere on the ruler / empty timeline moves the playhead smoothly
// across the whole timeline. The needle follows the cursor immediately (so it
// feels fluid even when the video can only seek a few times per second), while
// the actual video seek is throttled to one per animation frame.
let scrubbing = false
let scrubRaf = 0
let scrubTargetT = 0

function scheduleScrubSeek() {
  if (scrubRaf) return
  scrubRaf = requestAnimationFrame(() => {
    scrubRaf = 0
    ui.video.currentTime = scrubTargetT
    updateCaption()
  })
}

function scrubToClientX(clientX) {
  const rect = ui.timelineTrack.getBoundingClientRect()
  const dur = tlTotalDuration()
  const t = Math.max(0, Math.min(dur, (clientX - rect.left) / tlPxPerSec))
  scrubTargetT = t
  // Move the needle right away for a smooth, responsive feel.
  if (ui.timelinePlayhead)
    ui.timelinePlayhead.style.transform = `translate3d(${t * tlPxPerSec}px,0,0)`
  if (ui.tlClock)
    ui.tlClock.textContent = `${formatClock(t)} / ${formatClock(dur)}`
  scheduleScrubSeek()
}

ui.timelineTrack?.addEventListener("pointerdown", (event) => {
  // Subtitle blocks have their own drag/trim behaviour.
  if (event.target.closest(".tl-block")) return
  scrubbing = true
  ui.timeline?.classList.add("is-scrubbing")
  ui.timelineTrack.setPointerCapture?.(event.pointerId)
  event.preventDefault()
  scrubToClientX(event.clientX)
})
ui.timelineTrack?.addEventListener("pointermove", (event) => {
  if (scrubbing) scrubToClientX(event.clientX)
})
function endScrub() {
  if (!scrubbing) return
  scrubbing = false
  ui.timeline?.classList.remove("is-scrubbing")
}
ui.timelineTrack?.addEventListener("pointerup", endScrub)
ui.timelineTrack?.addEventListener("pointercancel", endScrub)

// Drag / trim blocks.
ui.timelineBlocks?.addEventListener("pointerdown", (event) => {
  const block = event.target.closest(".tl-block")
  if (!block) return
  const handle = event.target.closest(".tl-handle")
  const index = Number(block.dataset.index)
  const seg = currentSegments()[index]
  if (!seg) return
  event.preventDefault()
  tlDrag = {
    index,
    seg,
    block,
    mode: handle ? handle.dataset.edge : "move",
    startX: event.clientX,
    origStart: seg.start,
    origEnd: seg.end,
    moved: false,
    before: snapshotSegments(),
  }
  block.setPointerCapture?.(event.pointerId)
  block.classList.add("is-dragging")
})

ui.timelineBlocks?.addEventListener("pointermove", (event) => {
  if (!tlDrag) return
  const dx = event.clientX - tlDrag.startX
  const dt = dx / tlPxPerSec
  if (Math.abs(dx) > 3) tlDrag.moved = true
  const dur0 = tlDrag.origEnd - tlDrag.origStart
  const { seg, mode } = tlDrag
  if (mode === "move") {
    const ns = Math.max(0, tlDrag.origStart + dt)
    seg.start = ns
    seg.end = ns + dur0
  } else if (mode === "start") {
    seg.start = Math.max(
      0,
      Math.min(tlDrag.origEnd - TL_MIN_DUR, tlDrag.origStart + dt),
    )
  } else {
    seg.end = Math.max(tlDrag.origStart + TL_MIN_DUR, tlDrag.origEnd + dt)
  }
  tlDrag.block.style.left = `${seg.start * tlPxPerSec}px`
  tlDrag.block.style.width = `${(seg.end - seg.start) * tlPxPerSec}px`
  // Mirror to the sidebar inputs live.
  const li = $(`.seg[data-index="${tlDrag.index}"]`, ui.segList)
  if (li) {
    const s = $<HTMLInputElement>(".t-start", li)
    const e = $<HTMLInputElement>(".t-end", li)
    if (s) s.value = formatClock(seg.start)
    if (e) e.value = formatClock(seg.end)
  }
  updateCaption()
})

function endTimelineDrag() {
  if (!tlDrag) return
  const { block, moved, seg, index, before } = tlDrag
  block.classList.remove("is-dragging")
  tlDrag = null
  if (moved) pushHistory(before)
  currentSegments().sort((a, b) => a.start - b.start)
  renderSegments()
  enableExports(true)
  if (!moved) {
    // A simple click on the block selects it: seek there and mark the matching
    // line in the sidebar (scrolling it into view).
    ui.video.currentTime = seg.start
    const newIndex = currentSegments().indexOf(seg)
    highlightSegment(newIndex >= 0 ? newIndex : index, { scrollSidebar: true })
  }
  updateCaption()
}

ui.timelineBlocks?.addEventListener("pointerup", endTimelineDrag)
ui.timelineBlocks?.addEventListener("pointercancel", endTimelineDrag)

ui.tlPlay?.addEventListener("click", () => {
  if (ui.video.paused) ui.video.play().catch(() => {})
  else ui.video.pause()
})
// Drive the playhead at the display refresh rate while playing. Reading
// `video.currentTime` straight from the loop is jittery because the browser only
// advances it in coarse steps, so we interpolate from a wall-clock anchor
// (anchor time + elapsed real time × playbackRate) and gently re-anchor whenever
// the real media time drifts from the prediction (seeks, stalls, end of file).
let playheadRaf = 0
let phAnchorMedia = 0
let phAnchorWall = 0
function reanchorPlayhead() {
  phAnchorMedia = ui.video.currentTime || 0
  phAnchorWall = performance.now()
}
function playheadLoop() {
  const real = ui.video.currentTime || 0
  const rate = ui.video.playbackRate || 1
  let predicted = phAnchorMedia + ((performance.now() - phAnchorWall) / 1000) * rate
  // Correct drift: the real clock jumped, stalled, or the prediction ran ahead.
  if (Math.abs(real - predicted) > 0.18 || real < predicted - 0.03) {
    reanchorPlayhead()
    predicted = real
  }
  updateTimelinePlayhead(Math.min(predicted, tlTotalDuration()))
  playheadRaf = requestAnimationFrame(playheadLoop)
}
ui.video.addEventListener("play", () => {
  ui.timeline?.classList.add("is-playing")
  cancelAnimationFrame(playheadRaf)
  reanchorPlayhead()
  playheadLoop()
})
ui.video.addEventListener("pause", () => {
  ui.timeline?.classList.remove("is-playing")
  cancelAnimationFrame(playheadRaf)
  playheadRaf = 0
  updateTimelinePlayhead()
})
// Keep the interpolation honest across seeks and speed changes.
ui.video.addEventListener("seeked", reanchorPlayhead)
ui.video.addEventListener("ratechange", reanchorPlayhead)

// ── Custom video controls (native controls are off so subtitles render in
// fullscreen too — we go fullscreen on the preview container, not the <video>). ──
function togglePlay() {
  if (ui.video.paused) ui.video.play().catch(() => {})
  else ui.video.pause()
}
// Clicking the video itself toggles playback, like any player.
ui.video.addEventListener("click", togglePlay)

function syncVolumeUi() {
  const muted = ui.video.muted || ui.video.volume === 0
  ui.timeline?.classList.toggle("is-muted", muted)
  if (ui.vpVolume) ui.vpVolume.value = String(muted ? 0 : ui.video.volume)
}
ui.vpMute?.addEventListener("click", () => {
  ui.video.muted = !ui.video.muted
  // Restore an audible level if the user unmutes from zero.
  if (!ui.video.muted && ui.video.volume === 0) ui.video.volume = 1
})
ui.vpVolume?.addEventListener("input", () => {
  const v = Number(ui.vpVolume.value)
  ui.video.volume = v
  ui.video.muted = v === 0
})
ui.video.addEventListener("volumechange", syncVolumeUi)

function isFullscreen() {
  const doc = document as any
  return (
    (doc.fullscreenElement || doc.webkitFullscreenElement) === ui.videoPreview
  )
}
ui.vpFullscreen?.addEventListener("click", () => {
  const doc = document as any
  if (isFullscreen()) {
    ;(doc.exitFullscreen || doc.webkitExitFullscreen)?.call(document)
  } else {
    const el = ui.videoPreview as any
    ;(el?.requestFullscreen || el?.webkitRequestFullscreen)?.call(el)
  }
})
function syncFullscreenUi() {
  ui.timeline?.classList.toggle("is-fullscreen", isFullscreen())
}
document.addEventListener("fullscreenchange", syncFullscreenUi)
document.addEventListener("webkitfullscreenchange", syncFullscreenUi)
syncVolumeUi()
ui.tlZoomIn?.addEventListener("click", () => {
  tlPxPerSec = Math.min(400, tlPxPerSec * 1.4)
  renderTimeline()
})
ui.tlZoomOut?.addEventListener("click", () => {
  tlPxPerSec = Math.max(12, tlPxPerSec / 1.4)
  renderTimeline()
})
ui.video.addEventListener("loadedmetadata", () => {
  tlDuration = Number.isFinite(ui.video.duration) ? ui.video.duration : 0
  renderTimeline()
})

// Horizontally bring a subtitle block into view inside the timeline scroller.
function scrollTimelineToBlock(index) {
  const view = ui.timelineScroll
  const seg = currentSegments()[index]
  if (!view || !seg) return
  const left = seg.start * tlPxPerSec
  const right = Math.max(left + TL_MIN_DUR * tlPxPerSec, seg.end * tlPxPerSec)
  if (
    left < view.scrollLeft + 8 ||
    right > view.scrollLeft + view.clientWidth - 8
  ) {
    view.scrollLeft = Math.max(0, left - view.clientWidth * 0.3)
  }
}

// Mark a segment as active in BOTH the timeline and the sidebar so the two
// panes always stay in sync. `touchSidebar` is skipped while editing a line so
// playback doesn't yank the highlight off the line being edited.
function highlightSegment(
  index,
  { scrollSidebar = false, scrollTimeline = false, touchSidebar = true } = {},
) {
  setTimelineActive(index)
  if (touchSidebar) {
    $$(".seg.is-active", ui.segList).forEach((el) =>
      el.classList.remove("is-active"),
    )
    if (index >= 0) {
      const li = $(`.seg[data-index="${index}"]`, ui.segList)
      if (li) {
        li.classList.add("is-active")
        if (scrollSidebar) li.scrollIntoView({ block: "nearest" })
      }
    }
  }
  if (scrollTimeline && index >= 0) scrollTimelineToBlock(index)
}

// ── Caption overlay + active highlight ──
function updateCaption() {
  updateTimelinePlayhead()
  const segments = currentSegments()
  const editing = document.activeElement?.tagName === "TEXTAREA"
  if (!segments.length || !ui.video.duration) {
    ui.caption.textContent = ""
    highlightSegment(-1, { touchSidebar: !editing })
    return
  }
  const current = ui.video.currentTime
  const idx = segments.findIndex(
    (s) => current >= s.start && current <= s.end,
  )
  ui.caption.textContent = idx >= 0 ? segments[idx].text : ""
  highlightSegment(idx, { touchSidebar: !editing, scrollSidebar: !editing })
}

// ── File handling ──
function handleSelectedFile(file) {
  if (!file) return
  const isVideo =
    file.type.startsWith("video/") ||
    file.type === "" ||
    /\.(mp4|mov|webm|mkv|avi|m4v|ogv|wmv)$/i.test(file.name)
  if (!isVideo) return

  if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl)
  selectedVideoFile = file
  videoObjectUrl = URL.createObjectURL(file)
  ui.video.src = videoObjectUrl
  ui.video.load()
  ui.configVideo.src = videoObjectUrl
  ui.configVideo.load()

  baseSegments = []
  segmentsByLang = {}
  orderedLangs = []
  activeLang = ""
  ui.langTabs.innerHTML = ""
  setLangAddStatus("")
  populateAddLang()
  renderSegments()
  ui.addSegBtn.disabled = true
  enableExports(false)
  resetHistory()

  ui.outputLang.value = "same"
  ui.inputLang.value = ""

  const metaText = `${file.name} · ${prettifyBytes(file.size)}`
  ui.meta.textContent = metaText
  ui.configMeta.textContent = metaText
  setStatus(tt("videoLoaded"), "ok")
  setProgress(0)
  ui.configProgress.hidden = true
  ui.configError.hidden = true
  ui.configError.textContent = ""
  setStage("config")
}

function resetFlow() {
  if (exporting) return
  if (videoObjectUrl) {
    URL.revokeObjectURL(videoObjectUrl)
    videoObjectUrl = ""
  }
  selectedVideoFile = null
  baseSegments = []
  segmentsByLang = {}
  orderedLangs = []
  activeLang = ""
  ui.langTabs.innerHTML = ""
  setLangAddStatus("")
  populateAddLang()
  ui.caption.textContent = ""
  ui.video.removeAttribute("src")
  ui.video.load()
  ui.configVideo.removeAttribute("src")
  ui.configVideo.load()
  enableExports(false)
  resetHistory()
  setStage("upload")
}

// Back from editor to the configuration step.
function backToConfig() {
  if (exporting) return
  ui.video.pause()
  setStage("config")
}

// ── Download .srt ──
function downloadSrt() {
  const segments = currentSegments()
  if (!segments.length) return
  const blob = new Blob([buildSrt(segments)], {
    type: "text/plain;charset=utf-8",
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = `${baseFileName()}.${activeLang}.srt`
  link.click()
  URL.revokeObjectURL(url)
}

// ── Download video with burned-in subtitles (canvas + MediaRecorder) ──
function wrapText(ctx, text, maxWidth) {
  const words = text.split(/\s+/)
  const lines = []
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
  return lines
}

function drawSubtitlesAt(ctx, time, w, h, segments) {
  const seg = segments.find((s) => time >= s.start && time <= s.end)
  if (!seg || !seg.text.trim()) return

  const c = captionStyle
  const fontSize = Math.round(h * 0.052 * c.size)
  ctx.font = `${c.weight} ${fontSize}px ${FONT_STACKS[c.font] || FONT_STACKS.sans}`
  ctx.textAlign = "center"
  ctx.textBaseline = "alphabetic"

  const lines = wrapText(ctx, seg.text.trim(), w * 0.82)
  const lineHeight = fontSize * 1.28
  const padX = fontSize * 0.5
  const padY = fontSize * 0.3
  const blockH = lines.length * lineHeight
  let y
  if (c.position === "top") {
    y = h * 0.08 + fontSize
  } else if (c.position === "middle") {
    y = (h - blockH) / 2 + fontSize
  } else {
    y = h - h * 0.06 - (lines.length - 1) * lineHeight
  }

  lines.forEach((line) => {
    const metrics = ctx.measureText(line)
    if (c.bgEnabled) {
      const boxW = metrics.width + padX * 2
      const boxH = lineHeight + padY
      ctx.fillStyle = hexToRgba(c.bgColor, c.bgOpacity)
      const boxX = (w - boxW) / 2
      const boxY = y - fontSize - padY / 2
      const r = fontSize * 0.18
      ctx.beginPath()
      ctx.moveTo(boxX + r, boxY)
      ctx.arcTo(boxX + boxW, boxY, boxX + boxW, boxY + boxH, r)
      ctx.arcTo(boxX + boxW, boxY + boxH, boxX, boxY + boxH, r)
      ctx.arcTo(boxX, boxY + boxH, boxX, boxY, r)
      ctx.arcTo(boxX, boxY, boxX + boxW, boxY, r)
      ctx.closePath()
      ctx.fill()
    }

    // Outline / soft shadow for readability when there's no box.
    if (!c.bgEnabled && c.outline) {
      ctx.lineWidth = Math.max(2, fontSize * 0.14)
      ctx.strokeStyle = "rgba(0, 0, 0, 0.85)"
      ctx.lineJoin = "round"
      ctx.miterLimit = 2
      ctx.strokeText(line, w / 2, y)
    } else if (!c.bgEnabled) {
      ctx.shadowColor = "rgba(0, 0, 0, 0.8)"
      ctx.shadowBlur = fontSize * 0.25
      ctx.shadowOffsetY = fontSize * 0.04
    }

    ctx.fillStyle = c.color
    ctx.fillText(line, w / 2, y)
    ctx.shadowColor = "transparent"
    ctx.shadowBlur = 0
    ctx.shadowOffsetY = 0
    y += lineHeight
  })
}

function drawFrame(ctx, video, w, h, segments) {
  ctx.drawImage(video, 0, 0, w, h)
  drawSubtitlesAt(ctx, video.currentTime, w, h, segments)
}

// ── Export progress modal ──
const EXPORT_STEPS = [
  { id: "prepare", label: tt("exportSteps.prepare") },
  { id: "render", label: tt("exportSteps.render") },
  { id: "encode", label: tt("exportSteps.encode") },
  { id: "done", label: tt("exportSteps.done") },
]

function openExportModal() {
  ui.exportSteps.innerHTML = EXPORT_STEPS.map(
    (s) =>
      `<li class="export-step" data-id="${s.id}" data-state="pending"><span class="export-step-dot"></span><span class="export-step-label">${s.label}</span></li>`,
  ).join("")
  ui.exportError.hidden = true
  ui.exportError.textContent = ""
  ui.exportClose.hidden = true
  ui.exportTitle.textContent = tt("exportStages.exporting")
  ui.exportHint.hidden = false
  setExportStep("prepare", "active")
  setExportStage(tt("exportStages.preparing"), "busy")
  setExportProgress(0)
  ui.exportModal.hidden = false
}

function closeExportModal() {
  if (exporting) return
  ui.exportModal.hidden = true
}

function setExportStage(text, kind = "busy") {
  ui.exportStage.textContent = text
  ui.exportStage.dataset.kind = kind
}

function setExportProgress(percent) {
  const clamped = Math.max(0, Math.min(100, percent))
  ui.exportFill.style.width = `${clamped}%`
  ui.exportPct.textContent = `${Math.round(clamped)}%`
}

function setExportStep(id, state) {
  const el = $(`[data-id="${id}"]`, ui.exportSteps)
  if (el) el.dataset.state = state
}

function failExport(message) {
  setExportStage(tt("exportStages.failed"), "error")
  ui.exportError.textContent = message
  ui.exportError.hidden = false
  ui.exportHint.hidden = true
  ui.exportClose.hidden = false
}

// ── Download video with burned-in subtitles ──
// Modern path: WebCodecs via mediabunny (faster than real time, MP4 output,
// no real-time playback needed). Fallback: canvas + MediaRecorder.
function canUseWebCodecs() {
  return (
    typeof VideoEncoder !== "undefined" &&
    typeof VideoDecoder !== "undefined" &&
    typeof OffscreenCanvas !== "undefined"
  )
}

async function downloadVideo() {
  const segments = currentSegments()
  if (!segments.length || exporting) return

  exporting = true
  ui.downloadVideoBtn.disabled = true
  ui.downloadSrtBtn.disabled = true
  ui.transcribeBtn.disabled = true
  ui.backBtn.disabled = true

  try {
    if (canUseWebCodecs() && selectedVideoFile) {
      const handled = await exportWithWebCodecs(segments)
      if (handled) return
    }
    await exportWithRecorder(segments)
  } finally {
    exporting = false
    ui.backBtn.disabled = false
    ui.transcribeBtn.disabled = false
    enableExports(true)
  }
}

// ── WebCodecs export (mediabunny Conversion) ──
// Returns true when the WebCodecs pipeline took ownership of the export
// (whether it succeeded or surfaced an error to the user). Returns false when
// the pipeline isn't viable and the caller should fall back to MediaRecorder.
async function exportWithWebCodecs(segments) {
  let mediabunny
  try {
    mediabunny = await import("mediabunny")
  } catch (e) {
    console.warn("[export] mediabunny failed to load, falling back", e)
    return false
  }

  const {
    Input,
    Output,
    Conversion,
    BlobSource,
    ALL_FORMATS,
    Mp4OutputFormat,
    BufferTarget,
  } = mediabunny

  openExportModal()
  setExportStep("prepare", "active")
  setExportStage(tt("exportStages.preparingEncoder"), "busy")
  ui.exportHint.textContent = tt("exportStages.renderingLocally")

  const input = new Input({
    source: new BlobSource(selectedVideoFile),
    formats: ALL_FORMATS,
  })
  const output = new Output({
    format: new Mp4OutputFormat(),
    target: new BufferTarget(),
  })

  let canvas = null
  let ctx = null

  let conversion
  try {
    conversion = await Conversion.init({
      input,
      output,
      video: {
        codec: "avc",
        // Draw each decoded frame plus its subtitle onto a canvas. mediabunny
        // re-encodes the returned canvas while keeping the sample's timestamp.
        process: (sample) => {
          if (!ctx) {
            canvas = new OffscreenCanvas(
              sample.displayWidth,
              sample.displayHeight,
            )
            ctx = canvas.getContext("2d")
          }
          sample.draw(ctx, 0, 0)
          drawSubtitlesAt(ctx, sample.timestamp, canvas.width, canvas.height, segments)
          return canvas
        },
      },
    })
  } catch (e) {
    console.warn("[export] WebCodecs init failed, falling back", e)
    return false
  }

  if (!conversion.isValid) {
    console.warn(
      "[export] WebCodecs conversion invalid, falling back",
      conversion.discardedTracks,
    )
    return false
  }

  conversion.onProgress = (p) => {
    // Reserve the last 5% for writing the file to disk.
    setExportProgress(Math.min(95, p * 95))
  }

  setExportStep("prepare", "done")
  setExportStep("render", "active")
  setExportStage(tt("exportStages.renderingVideo"), "busy")

  try {
    await conversion.execute()
  } catch (e) {
    console.error(e)
    failExport(
      tt("exportErrors.webcodecsFailed", {
        error: e?.message || "unknown error",
      }),
    )
    return true
  }

  setExportStep("render", "done")
  setExportStep("encode", "done")
  setExportStep("done", "active")
  setExportStage(tt("exportStages.saving"), "busy")

  const blob = new Blob([output.target.buffer], { type: "video/mp4" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = `${baseFileName()}.${activeLang}.mp4`
  link.click()
  URL.revokeObjectURL(url)

  setExportStep("done", "done")
  setExportProgress(100)
  setExportStage(tt("exportStages.exported"), "ok")
  ui.exportTitle.textContent = tt("exportStages.complete")
  ui.exportHint.hidden = true
  ui.exportClose.hidden = false
  setStatus(tt("videoExported"), "ok")
  return true
}

// ── Fallback export (canvas + MediaRecorder, plays in real time) ──
async function exportWithRecorder(segments) {
  const video = ui.video

  openExportModal()

  const capture = video.captureStream
    ? video.captureStream.bind(video)
    : video.mozCaptureStream
      ? video.mozCaptureStream.bind(video)
      : null
  if (!capture || typeof MediaRecorder === "undefined") {
    failExport(tt("exportErrors.noSupport"))
    return
  }

  const w = video.videoWidth || 1280
  const h = video.videoHeight || 720
  const canvas = document.createElement("canvas")
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext("2d")

  const canvasStream = canvas.captureStream(30)
  let hasAudio = false
  try {
    const elementStream = capture()
    elementStream.getAudioTracks().forEach((track) => {
      canvasStream.addTrack(track)
      hasAudio = true
    })
  } catch (e) {
    console.warn("No audio track for the export", e)
  }

  const mimeType =
    [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ].find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm"
  let recorder
  try {
    recorder = new MediaRecorder(canvasStream, {
      mimeType,
      videoBitsPerSecond: 8_000_000,
    })
  } catch (e) {
    console.error(e)
    failExport(tt("exportErrors.recordStart"))
    return
  }

  const chunks = []
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data)
  }

  const finished = new Promise((resolve) => {
    recorder.onstop = () => {
      setExportStep("render", "done")
      setExportStep("encode", "active")
      setExportStage(tt("exportStages.generatingFile"), "busy")
      const blob = new Blob(chunks, { type: "video/webm" })
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = `${baseFileName()}.${activeLang}.webm`
      link.click()
      URL.revokeObjectURL(url)
      resolve()
    }
  })

  const previousVolume = video.volume
  const wasMuted = video.muted
  video.muted = true
  video.volume = 0

  setExportStage(tt("exportStages.preparingVideo"), "busy")
  video.pause()
  try {
    video.currentTime = 0
  } catch {}
  await new Promise((r) => setTimeout(r, 150))

  setExportStep("prepare", "done")
  setExportStep("render", "active")
  setExportStage(
    hasAudio
      ? tt("exportStages.recordingAudio")
      : tt("exportStages.recordingNoAudio"),
    "busy",
  )
  ui.exportHint.textContent = tt("exportStages.keepTabActive")

  let raf = 0
  let stopped = false
  const stopRecording = () => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(raf)
    video.removeEventListener("ended", onEnded)
    if (recorder.state !== "inactive") recorder.stop()
  }
  const onEnded = () => stopRecording()

  const tick = () => {
    drawFrame(ctx, video, w, h, segments)
    const dur = video.duration
    if (dur && isFinite(dur)) {
      // Reserve the last 6% for file generation.
      setExportProgress(Math.min(94, (video.currentTime / dur) * 94))
      if (video.currentTime >= dur - 0.05) {
        stopRecording()
        return
      }
    }
    raf = requestAnimationFrame(tick)
  }

  video.addEventListener("ended", onEnded)
  recorder.start(100)
  tick()

  try {
    await video.play()
  } catch (e) {
    console.error(e)
    stopRecording()
    recorder.onstop = null
    if (recorder.state !== "inactive") recorder.stop()
    video.muted = wasMuted
    video.volume = previousVolume
    failExport(tt("exportErrors.playbackBlocked"))
    return
  }

  await finished

  video.muted = wasMuted
  video.volume = previousVolume

  setExportStep("encode", "done")
  setExportStep("done", "done")
  setExportProgress(100)
  setExportStage(tt("exportStages.exported"), "ok")
  ui.exportTitle.textContent = tt("exportStages.complete")
  ui.exportHint.hidden = true
  ui.exportClose.hidden = false
  setStatus(tt("videoExported"), "ok")
}

// ── Global drag & drop ──
function attachGlobalDrop() {
  const hasFiles = (e) =>
    Array.from(e.dataTransfer?.types || []).includes("Files")
  const setDragging = (active) => {
    ui.dropzone.classList.toggle("over", active)
    ui.app.classList.toggle("is-dragging", active)
  }
  document.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth += 1
    setDragging(true)
  })
  document.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
  })
  document.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) setDragging(false)
  })
  document.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth = 0
    setDragging(false)
    handleSelectedFile(e.dataTransfer?.files?.[0])
  })
}

// ── Subtitle style: live preview + presets ──
function hexToRgba(hex, alpha = 1) {
  let h = String(hex || "#000000").replace("#", "")
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("")
  }
  const n = parseInt(h, 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// Apply the visual part of a style (font, color, background, shadow) to any
// element — shared by the live overlay and the preset thumbnails.
function applyVisualStyle(el, s) {
  el.style.fontFamily = FONT_STACKS[s.font] || FONT_STACKS.sans
  el.style.fontWeight = String(s.weight || 600)
  el.style.color = s.color || "#ffffff"
  el.style.background = s.bgEnabled
    ? hexToRgba(s.bgColor, s.bgOpacity)
    : "transparent"
  el.style.textShadow = s.outline
    ? "0 1px 2px rgba(0,0,0,.95), 0 0 5px rgba(0,0,0,.85), 0 0 1px rgba(0,0,0,.9)"
    : s.bgEnabled
      ? "none"
      : "0 1px 3px rgba(0,0,0,.85)"
}

function applyCaptionStyle() {
  const c = captionStyle
  applyVisualStyle(ui.caption, c)
  ui.caption.style.fontSize = `clamp(${Math.round(13 * c.size)}px, ${(
    2.4 * c.size
  ).toFixed(2)}vw, ${Math.round(28 * c.size)}px)`
  ui.caption.style.padding = c.bgEnabled ? "0.22rem 0.6rem" : "0"
  // Reset to "auto" (not "") so the stylesheet's `bottom: 8%` doesn't linger:
  // having both top and bottom set would stretch the box and balloon the
  // background when the caption sits at the top or middle.
  ui.caption.style.top = "auto"
  ui.caption.style.bottom = "auto"
  if (c.position === "middle") {
    ui.caption.style.top = "50%"
    ui.caption.style.transform = "translate(-50%, -50%)"
  } else if (c.position === "top") {
    ui.caption.style.top = "8%"
    ui.caption.style.transform = "translateX(-50%)"
  } else {
    ui.caption.style.bottom = "8%"
    ui.caption.style.transform = "translateX(-50%)"
  }
}

function renderPresets() {
  ui.stylePresets.innerHTML = ""
  CAPTION_PRESETS.forEach((p) => {
    const on = p.id === activePresetId
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "preset" + (on ? " is-on" : "")
    btn.setAttribute("role", "tab")
    btn.setAttribute("aria-selected", on ? "true" : "false")
    const presetName = I18N.presets?.[p.id] || p.name
    btn.title = presetName

    const prev = document.createElement("span")
    prev.className = "preset-prev"
    const inner = document.createElement("span")
    inner.textContent = "Aa"
    applyVisualStyle(inner, p.s)
    inner.style.padding = p.s.bgEnabled ? "1px 6px" : "0"
    inner.style.borderRadius = "4px"
    inner.style.fontSize = "13px"
    prev.appendChild(inner)

    const name = document.createElement("span")
    name.className = "preset-name"
    name.textContent = presetName

    btn.append(prev, name)
    btn.addEventListener("click", () => applyPreset(p))
    ui.stylePresets.appendChild(btn)
  })
}

function applyPreset(p) {
  Object.assign(captionStyle, p.s)
  activePresetId = p.id
  applyCaptionStyle()
  syncStyleControls()
  renderPresets()
}

function syncStyleControls() {
  const c = captionStyle
  ui.csFont.value = c.font
  ui.csSize.value = String(c.size)
  ui.csColor.value = c.color
  ui.csBold.checked = c.weight >= 700
  ui.csOutline.checked = !!c.outline
  ui.csBg.checked = !!c.bgEnabled
  ui.csBgColor.value = c.bgColor
  ui.csBgOpacity.value = String(c.bgOpacity)
  ui.csBgColor.disabled = !c.bgEnabled
  ui.csBgOpacity.disabled = !c.bgEnabled
  $$("button", ui.csPosition).forEach((b) => {
    b.classList.toggle("is-on", b.dataset.pos === c.position)
  })
}

// A manual tweak means we're no longer on a named preset.
function onManualStyleChange() {
  activePresetId = ""
  applyCaptionStyle()
  renderPresets()
}

function wireStyleControls() {
  ui.styleToggle.addEventListener("click", () => {
    const open = ui.styleControls.hidden
    ui.styleControls.hidden = !open
    ui.styleToggle.setAttribute("aria-expanded", String(open))
    ui.styleToggle.classList.toggle("is-open", open)
  })
  ui.csFont.addEventListener("change", () => {
    captionStyle.font = ui.csFont.value
    onManualStyleChange()
  })
  ui.csSize.addEventListener("input", () => {
    captionStyle.size = Number(ui.csSize.value)
    onManualStyleChange()
  })
  ui.csColor.addEventListener("input", () => {
    captionStyle.color = ui.csColor.value
    onManualStyleChange()
  })
  ui.csBold.addEventListener("change", () => {
    captionStyle.weight = ui.csBold.checked ? 700 : 600
    onManualStyleChange()
  })
  ui.csOutline.addEventListener("change", () => {
    captionStyle.outline = ui.csOutline.checked
    onManualStyleChange()
  })
  ui.csBg.addEventListener("change", () => {
    captionStyle.bgEnabled = ui.csBg.checked
    syncStyleControls()
    onManualStyleChange()
  })
  ui.csBgColor.addEventListener("input", () => {
    captionStyle.bgColor = ui.csBgColor.value
    onManualStyleChange()
  })
  ui.csBgOpacity.addEventListener("input", () => {
    captionStyle.bgOpacity = Number(ui.csBgOpacity.value)
    onManualStyleChange()
  })
  ui.csPosition.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-pos]")
    if (!b) return
    captionStyle.position = b.dataset.pos
    syncStyleControls()
    applyCaptionStyle()
  })
}

// ── Init ──
buildLangSelects()
renderDownloads()
renderPresets()
syncStyleControls()
applyCaptionStyle()
wireStyleControls()
preloadAssetsInBackground()
setStage("upload")
attachGlobalDrop()

ui.dropzone.addEventListener("click", () => ui.input.click())
ui.dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault()
    ui.input.click()
  }
})
ui.input.addEventListener("change", (e) =>
  handleSelectedFile(e.target?.files?.[0]),
)
ui.transcribeBtn.addEventListener("click", generate)
ui.backBtn.addEventListener("click", backToConfig)
ui.undoBtn?.addEventListener("click", undo)
ui.redoBtn?.addEventListener("click", redo)
ui.langAddSelect?.addEventListener("change", () => {
  const target = ui.langAddSelect.value
  if (target) addLanguage(target)
})
ui.configBackBtn.addEventListener("click", resetFlow)
ui.downloadSrtBtn.addEventListener("click", downloadSrt)
ui.downloadVideoBtn.addEventListener("click", downloadVideo)
ui.exportClose.addEventListener("click", closeExportModal)
ui.exportBackdrop.addEventListener("click", closeExportModal)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !ui.exportModal.hidden) closeExportModal()

  // Undo / redo. Only when the editor is open and the export modal is closed.
  // Inside text fields we defer to the browser's native text undo.
  if (
    (e.metaKey || e.ctrlKey) &&
    !ui.stageEditor.hidden &&
    ui.exportModal.hidden
  ) {
    const target = e.target
    const inField =
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable)
    const key = e.key.toLowerCase()
    if (!inField && (key === "z" || key === "y")) {
      const wantsRedo = key === "y" || (key === "z" && e.shiftKey)
      e.preventDefault()
      if (wantsRedo) redo()
      else undo()
      return
    }
  }

  if (e.key === " " && !ui.stageEditor.hidden && ui.exportModal.hidden) {
    const target = e.target
    const isTyping =
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable)
    if (!isTyping) {
      e.preventDefault()
      if (ui.video.paused) ui.video.play().catch(() => {})
      else ui.video.pause()
    }
  }
})
ui.video.addEventListener("timeupdate", updateCaption)
ui.video.addEventListener("seeked", updateCaption)
ui.downloadsToggle.addEventListener("click", () => {
  const opening = ui.downloadsPanel.hidden
  ui.downloadsPanel.hidden = !opening
  // The panel header already shows the status, so drop the dock label while open.
  ui.statusDock?.classList.toggle("panel-open", opening)
  if (opening) refreshClearModelsUI()
})
ui.clearModelsBtn?.addEventListener("click", clearLocalModels)
