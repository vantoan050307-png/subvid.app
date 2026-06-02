import { prettifyBytes } from "@/scripts/file.ts"
import { ASR_MODEL, LANGS } from "@/scripts/languages.ts"
import { createAudioService } from "@/scripts/media/audio.ts"
import type { Stage } from "@/scripts/stageManager.ts"
import {
  normalizeLanguageCode,
  normalizeSegments,
} from "@/scripts/subtitles.ts"
import type { ui as appUi } from "@/scripts/ui.ts"

type Segment = { start: number; end: number; text: string }
type SegmentsByLang = Record<string, Segment[]>

type GeneratedState = {
  detectedLang: string
  baseSegments: Segment[]
  segmentsByLang: SegmentsByLang
  orderedLangs: string[]
  activeLang: string
  dualTrackMode: boolean
  dualTrackLangs: string[]
}

type ConfigStageOptions = {
  ui: typeof appUi
  tt: (path: string, vars?: Record<string, unknown>) => string
  downloads: any
  fetchWithProgress: (
    url: string,
    key: string,
    mimeType: string,
    fallbackTotal?: number,
  ) => Promise<string>
  updateDownloadStatus: (key: string, state: string) => void
  transformersClient: any
  translateSegments: (
    segments: Segment[],
    sourceLang: string,
    targetLang: string,
  ) => Promise<Segment[]>
  selectedVideoFile: () => File | null
  isExporting: () => boolean
  setGeneratedState: (state: GeneratedState) => void
  renderTabs: () => void
  renderSegments: () => void
  enableExports: (on: boolean) => void
  resetHistory: () => void
  updateCaption: () => void
  setStage: (stage: Stage) => void
}

const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator

export function createConfigStageController({
  ui,
  tt,
  downloads,
  fetchWithProgress,
  updateDownloadStatus,
  transformersClient,
  translateSegments,
  selectedVideoFile,
  isExporting,
  setGeneratedState,
  renderTabs,
  renderSegments,
  enableExports,
  resetHistory,
  updateCaption,
  setStage,
}: ConfigStageOptions) {
  let asrReady = false
  let progressRaf = 0
  let progressIndeterminate = false

  function setStatus(message: string, kind = "ok") {
    ui.configStatus.textContent = message
    ui.configStatus.dataset.kind = kind
  }

  function setProgress(percent: number) {
    setIndeterminate(false)
    applyProgress(percent)
  }

  function setIndeterminate(on: boolean) {
    if (on) stopProgressCreep()
    progressIndeterminate = on
    ui.configProgressFill.classList.toggle("is-indeterminate", on)
    if (on) ui.configProgressPct.textContent = ""
  }

  function applyProgress(percent: number) {
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

  function startProgressCreep(from: number, ceiling: number, expected: number) {
    stopProgressCreep()
    const start = performance.now()
    const span = ceiling - from
    const tick = (now: number) => {
      const t = (now - start) / Math.max(1, expected)
      const eased = 1 - Math.exp(-1.6 * t)
      applyProgress(from + span * eased)
      progressRaf = requestAnimationFrame(tick)
    }
    progressRaf = requestAnimationFrame(tick)
  }

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

  function outputTarget(sourceLang: string) {
    const value = ui.outputLang.value
    if (!value || value === "same") return sourceLang
    return value in LANGS ? value : sourceLang
  }

  function canEnableDualTrackOption() {
    const target = ui.outputLang.value
    return !ui.inputLang.value && !!target && target !== "same"
  }

  function syncDualTrackOption() {
    const available = canEnableDualTrackOption()
    ui.dualTrackField.hidden = !available
    ui.dualTrack.disabled = !available
    if (!available) ui.dualTrack.checked = false
  }

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

  async function preloadAssetsInBackground() {
    await Promise.allSettled([
      ensureFfmpeg().catch((error) => {
        console.error(error)
        updateDownloadStatus("ffmpeg", "error")
      }),
      ensureRecognizer().catch((error) => {
        console.error(error)
        updateDownloadStatus("asr", "error")
      }),
    ])
  }

  async function generate() {
    const file = selectedVideoFile()
    if (!file || isExporting()) return

    ui.transcribeBtn.disabled = true
    ui.downloadVideoBtn.disabled = true
    ui.downloadSrtBtn.disabled = true
    ui.configError.hidden = true
    ui.configError.textContent = ""
    ui.configProgress.hidden = false
    setStatus(tt("steps.preparing"), "busy")
    setProgress(2)

    try {
      const audio = await extractAudioBuffer(file)
      setStatus(tt("steps.loadingSpeech"), "busy")
      startProgressCreep(38, 48, 8000)

      const asrMonitor = setInterval(() => {
        const download = downloads.asr
        if (download.state === "downloading" && download.total) {
          stopProgressCreep()
          const ratio = Math.min(1, download.progress / 100)
          applyProgress(38 + ratio * 10)
          const meta =
            prettifyBytes(download.loaded) + " / " + prettifyBytes(download.total)
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

      const TR_START = 48
      const TR_END = 90
      const audioSeconds = audio.length / 16000
      const chunkSeconds = 30 - 2 * 5
      const totalChunks = Math.max(1, Math.ceil(audioSeconds / chunkSeconds))
      const chunkSpan = (TR_END - TR_START) / totalChunks
      let chunksDone = 0
      let lastChunkAt = performance.now()
      let perChunkMs = Math.max(2000, (audioSeconds / totalChunks) * 900)

      const transcribeStatus = () => {
        setStatus(tt("steps.transcribing"), "busy")
      }

      transcribeStatus()
      applyProgress(TR_START)
      startProgressCreep(TR_START, TR_START + chunkSpan, perChunkMs)

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

      let output: any
      try {
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

      const detectedLang =
        normalizeLanguageCode(output?.language) ||
        normalizeLanguageCode(ui.inputLang.value) ||
        "en"
      const baseSegments = normalizeSegments(output)

      if (!baseSegments.length) throw new Error(tt("noSpeech"))

      const target = outputTarget(detectedLang)
      const targets = [detectedLang]
      if (target !== detectedLang && !targets.includes(target))
        targets.push(target)
      const dualTrackMode =
        ui.dualTrack.checked &&
        !ui.inputLang.value &&
        target !== detectedLang &&
        targets.includes(target)

      const TX_START = 92
      const TX_SPAN = 100 - TX_START
      const segmentsByLang: SegmentsByLang = {}
      let done = 0

      for (const lang of targets) {
        if (lang === detectedLang) {
          segmentsByLang[lang] = baseSegments.map((segment) => ({ ...segment }))
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

      setGeneratedState({
        detectedLang,
        baseSegments,
        segmentsByLang,
        orderedLangs: targets,
        activeLang: target,
        dualTrackMode,
        dualTrackLangs: dualTrackMode ? [detectedLang, target] : [],
      })
      renderTabs()
      renderSegments()
      enableExports(true)
      ui.addSegBtn.disabled = false
      resetHistory()
      setProgress(100)
      setStatus(
        tt("ready", { n: baseSegments.length, count: targets.length }),
        "ok",
      )
      setStage("editor")
      updateCaption()
      ui.configProgress.hidden = true
    } catch (error: any) {
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

  function wireConfigStage() {
    ui.transcribeBtn.addEventListener("click", generate)
    ui.inputLang.addEventListener("change", syncDualTrackOption)
    ui.outputLang.addEventListener("change", syncDualTrackOption)
    syncDualTrackOption()
  }

  return {
    setStatus,
    setProgress,
    applyProgress,
    setIndeterminate,
    startProgressCreep,
    stopProgressCreep,
    ensureRecognizer,
    preloadAssetsInBackground,
    generate,
    wireConfigStage,
  }
}
