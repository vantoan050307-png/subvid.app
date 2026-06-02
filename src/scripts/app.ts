import {
  hasBuiltInTranslationSupport,
} from "@/scripts/builtInTranslate.ts"
import { createDownloadsController } from "@/scripts/downloads.ts"
import { createEditorHistory } from "@/scripts/editorHistory.ts"
import { createEditorSegmentsController } from "@/scripts/editorSegments.ts"
import { createExportModal } from "@/scripts/export/exportModal.ts"
import { createVideoExporter } from "@/scripts/export/videoExport.ts"
import { baseFileName, prettifyBytes } from "@/scripts/file.ts"
import { I18N, langName, tt } from "@/scripts/i18n.ts"
import { createStageManager } from "@/scripts/stageManager.ts"
import { createConfigStageController } from "@/scripts/stages/configStage.ts"
import { createEditorStageController } from "@/scripts/stages/editorStage.ts"
import { createUploadStageController } from "@/scripts/stages/uploadStage.ts"
import { createSubtitleStyleController } from "@/scripts/subtitleStyle.ts"
import { createTimelineController } from "@/scripts/timeline.ts"
import { createTransformersClient } from "@/scripts/transformersClient.ts"
import { createTranslationService } from "@/scripts/translation.ts"
import { ui } from "@/scripts/ui.ts"

type Segment = { start: number; end: number; text: string }
type SegmentsByLang = Record<string, Segment[]>

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
let selectedVideoFile: File | null = null
let videoObjectUrl = ""
let detectedLang = ""
let baseSegments: Segment[] = []
let segmentsByLang: SegmentsByLang = {}
let orderedLangs: string[] = []
let activeLang = ""
let exporting = false

const { setStage } = createStageManager({ ui })
const asrTracker = makeTransformersTracker("asr")
const translationTracker = makeTransformersTracker("translation")
const transformersClient = createTransformersClient({
  onProgress(key, payload) {
    if (key === "asr") asrTracker(payload)
    else if (key === "translation") translationTracker(payload)
  },
})

let translationService: ReturnType<typeof createTranslationService>
let historyController: ReturnType<typeof createEditorHistory<SegmentsByLang>>
let editorStageController: ReturnType<typeof createEditorStageController>

const translateSegments = (
  segments: Segment[],
  sourceLang: string,
  targetLang: string,
) => translationService.translateSegments(segments, sourceLang, targetLang)

function currentSegments(): Segment[] {
  return segmentsByLang[activeLang] || []
}

function resetEditorState() {
  detectedLang = ""
  baseSegments = []
  segmentsByLang = {}
  orderedLangs = []
  activeLang = ""
}

function snapshotSegments() {
  return historyController.snapshotSegments()
}

function pushHistory(snapshotBefore: string) {
  historyController.pushHistory(snapshotBefore)
}

function resetHistory() {
  historyController.resetHistory()
}

function enableExports(on: boolean) {
  editorStageController.enableExports(on)
}

let editorSegmentsController: any
const { renderTimeline, highlightSegment, updateCaption } = createTimelineController({
  ui,
  currentSegments,
  snapshotSegments,
  pushHistory,
  renderSegments: () => editorSegmentsController.renderSegments(),
  enableExports,
})
editorSegmentsController = createEditorSegmentsController({
  ui,
  tt,
  langName,
  getState: () => ({
    detectedLang,
    baseSegments,
    segmentsByLang,
    orderedLangs,
    activeLang,
  }),
  setActiveLang: (lang) => {
    activeLang = lang
  },
  setOrderedLangs: (langs) => {
    orderedLangs = langs
  },
  setSegmentsForLang: (lang, segments) => {
    segmentsByLang[lang] = segments
  },
  currentSegments,
  translateSegments,
  snapshotSegments,
  pushHistory,
  renderTimeline,
  highlightSegment,
  updateCaption,
  enableExports,
})
const {
  addLanguage,
  buildLangSelects,
  populateAddLang,
  renderSegments,
  renderTabs,
  setLangAddStatus,
  wireSegmentEditor,
} = editorSegmentsController
const {
  applyCaptionStyle,
  renderPresets,
  syncStyleControls,
  wireStyleControls,
} = createSubtitleStyleController({ ui, I18N })
const exportModal = createExportModal({ ui, tt, isExporting: () => exporting })
const { closeExportModal } = exportModal

editorStageController = createEditorStageController({
  ui,
  currentSegments,
  selectedVideoFile: () => selectedVideoFile,
  activeLang: () => activeLang,
  isExporting: () => exporting,
  setStage,
  undo: () => historyController.undo(),
  redo: () => historyController.redo(),
})

historyController = createEditorHistory<SegmentsByLang>({
  getState: () => ({ segmentsByLang, orderedLangs, activeLang }),
  restoreState: (state) => {
    segmentsByLang = state.segmentsByLang || {}
    orderedLangs = state.orderedLangs || Object.keys(segmentsByLang)
    activeLang = state.activeLang || orderedLangs[0] || ""
    if (!segmentsByLang[activeLang])
      activeLang = orderedLangs[0] || Object.keys(segmentsByLang)[0] || ""
  },
  refreshButtons: (canUndo, canRedo) => {
    if (ui.undoBtn) ui.undoBtn.disabled = !canUndo
    if (ui.redoBtn) ui.redoBtn.disabled = !canRedo
  },
  onRestore: () => {
    renderTabs()
    renderSegments()
    enableExports(true)
    updateCaption()
  },
})

const configStageController = createConfigStageController({
  ui,
  tt,
  downloads,
  fetchWithProgress,
  updateDownloadStatus,
  transformersClient,
  translateSegments,
  selectedVideoFile: () => selectedVideoFile,
  isExporting: () => exporting,
  setGeneratedState: (state) => {
    detectedLang = state.detectedLang
    baseSegments = state.baseSegments
    segmentsByLang = state.segmentsByLang
    orderedLangs = state.orderedLangs
    activeLang = state.activeLang
  },
  renderTabs,
  renderSegments,
  enableExports,
  resetHistory,
  updateCaption,
  setStage,
})

translationService = createTranslationService({
  downloads,
  renderDownloads,
  updateDownloadStatus,
  transformersClient,
  tt,
  langName,
  setStatus: configStageController.setStatus,
})

const uploadStageController = createUploadStageController({
  ui,
  tt,
  setStage,
  setStatus: configStageController.setStatus,
  setProgress: configStageController.setProgress,
  isExporting: () => exporting,
  getVideoObjectUrl: () => videoObjectUrl,
  setVideoObjectUrl: (url) => {
    videoObjectUrl = url
  },
  setSelectedVideoFile: (file) => {
    selectedVideoFile = file
  },
  resetEditorState,
  setLangAddStatus,
  populateAddLang,
  renderSegments,
  enableExports,
  resetHistory,
})

const { downloadVideo } = createVideoExporter({
  ui,
  tt,
  currentSegments,
  selectedVideoFile: () => selectedVideoFile,
  activeLang: () => activeLang,
  baseFileName: () => baseFileName(selectedVideoFile),
  isExporting: () => exporting,
  setExporting: (value) => {
    exporting = value
  },
  enableExports,
  setStatus: configStageController.setStatus,
  modal: exportModal,
})

// ── Init ──
buildLangSelects()
renderDownloads()
renderPresets()
syncStyleControls()
applyCaptionStyle()
wireStyleControls()
wireSegmentEditor()
configStageController.preloadAssetsInBackground()
setStage("upload")
uploadStageController.wireUploadStage()
configStageController.wireConfigStage()
editorStageController.wireEditorStage()
ui.langAddSelect?.addEventListener("change", () => {
  const target = ui.langAddSelect.value
  if (target) addLanguage(target)
})
ui.downloadVideoBtn.addEventListener("click", downloadVideo)
ui.exportClose.addEventListener("click", closeExportModal)
ui.exportBackdrop.addEventListener("click", closeExportModal)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !ui.exportModal.hidden) closeExportModal()
})
ui.downloadsToggle.addEventListener("click", () => {
  const opening = ui.downloadsPanel.hidden
  ui.downloadsPanel.hidden = !opening
  // The panel header already shows the status, so drop the dock label while open.
  ui.statusDock?.classList.toggle("panel-open", opening)
  if (opening) refreshClearModelsUI()
})
ui.clearModelsBtn?.addEventListener("click", clearLocalModels)
