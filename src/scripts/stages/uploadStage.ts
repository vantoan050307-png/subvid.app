import { prettifyBytes } from "@/scripts/file.ts"
import type { Stage } from "@/scripts/stageManager.ts"
import type { ui as appUi } from "@/scripts/ui.ts"

type UploadStageOptions = {
  ui: typeof appUi
  tt: (path: string, vars?: Record<string, unknown>) => string
  setStage: (stage: Stage) => void
  setStatus: (message: string, kind?: string) => void
  setProgress: (percent: number) => void
  isExporting: () => boolean
  getVideoObjectUrl: () => string
  setVideoObjectUrl: (url: string) => void
  setSelectedVideoFile: (file: File | null) => void
  resetEditorState: () => void
  setLangAddStatus: (message: string, kind?: string) => void
  populateAddLang: () => void
  renderSegments: () => void
  enableExports: (on: boolean) => void
  resetHistory: () => void
}

function isVideoFile(file: File) {
  return (
    file.type.startsWith("video/") ||
    file.type === "" ||
    /\.(mp4|mov|webm|mkv|avi|m4v|ogv|wmv)$/i.test(file.name)
  )
}

export function createUploadStageController({
  ui,
  tt,
  setStage,
  setStatus,
  setProgress,
  isExporting,
  getVideoObjectUrl,
  setVideoObjectUrl,
  setSelectedVideoFile,
  resetEditorState,
  setLangAddStatus,
  populateAddLang,
  renderSegments,
  enableExports,
  resetHistory,
}: UploadStageOptions) {
  let dragDepth = 0

  function handleSelectedFile(file?: File) {
    if (!file || !isVideoFile(file)) return

    const previousUrl = getVideoObjectUrl()
    if (previousUrl) URL.revokeObjectURL(previousUrl)

    const videoObjectUrl = URL.createObjectURL(file)
    setSelectedVideoFile(file)
    setVideoObjectUrl(videoObjectUrl)
    ui.video.src = videoObjectUrl
    ui.video.load()
    ui.configVideo.src = videoObjectUrl
    ui.configVideo.load()

    resetEditorState()
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
    if (isExporting()) return

    const videoObjectUrl = getVideoObjectUrl()
    if (videoObjectUrl) {
      URL.revokeObjectURL(videoObjectUrl)
      setVideoObjectUrl("")
    }

    setSelectedVideoFile(null)
    resetEditorState()
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

  function attachGlobalDrop() {
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types || []).includes("Files")
    const setDragging = (active: boolean) => {
      ui.dropzone.classList.toggle("over", active)
      ui.app.classList.toggle("is-dragging", active)
    }

    document.addEventListener("dragenter", (event) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepth += 1
      setDragging(true)
    })
    document.addEventListener("dragover", (event) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
    })
    document.addEventListener("dragleave", (event) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepth = Math.max(0, dragDepth - 1)
      if (dragDepth === 0) setDragging(false)
    })
    document.addEventListener("drop", (event) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepth = 0
      setDragging(false)
      handleSelectedFile(event.dataTransfer?.files?.[0])
    })
  }

  function wireUploadStage() {
    attachGlobalDrop()
    ui.dropzone.addEventListener("click", () => ui.input.click())
    ui.dropzone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault()
        ui.input.click()
      }
    })
    ui.input.addEventListener("change", (event) => {
      const target = event.target as HTMLInputElement | null
      handleSelectedFile(target?.files?.[0])
    })
    ui.configBackBtn.addEventListener("click", resetFlow)
  }

  return {
    handleSelectedFile,
    resetFlow,
    attachGlobalDrop,
    wireUploadStage,
  }
}
