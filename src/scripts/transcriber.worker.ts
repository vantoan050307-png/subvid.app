// Dedicated Web Worker that hosts the transformers.js pipelines (Whisper ASR +
// NLLB translation). Loading these models and — especially — running inference
// is heavy CPU/WASM work that would otherwise freeze the main thread (the UI,
// progress bars, etc.). Keeping it here leaves the main thread free.
//
// Protocol (main ⇄ worker):
//   → { id, type: "ensure-asr" | "ensure-translation", payload: { model, webgpu } }
//   → { id, type: "transcribe", payload: { audio, language } }   // audio buffer transferred
//   → { id, type: "translate",  payload: { texts, src, tgt } }
//   ← { type: "progress", key, payload }   // streamed model-download progress
//   ← { type: "chunk" }                     // streamed per-chunk ASR progress
//   ← { id, type: "done", result? }         // request finished
//   ← { id, type: "error", error }          // request failed

import { env, pipeline } from "@xenova/transformers"

env.allowLocalModels = false
env.useBrowserCache = true

let recognizer: any = null
let translator: any = null

const post = (msg: any, transfer: Transferable[] = []) =>
  (self as any).postMessage(msg, transfer)

self.onmessage = async (event: MessageEvent) => {
  const { id, type, payload } = event.data || {}
  try {
    if (type === "ensure-asr") {
      if (!recognizer) {
        const options: any = {
          progress_callback: (p: any) =>
            post({ type: "progress", key: "asr", payload: p }),
        }
        if (payload?.webgpu) options.device = "webgpu"
        recognizer = await pipeline(
          "automatic-speech-recognition",
          payload.model,
          options,
        )
      }
      post({ id, type: "done" })
    } else if (type === "ensure-translation") {
      if (!translator) {
        translator = await pipeline("translation", payload.model, {
          progress_callback: (p: any) =>
            post({ type: "progress", key: "translation", payload: p }),
        })
      }
      post({ id, type: "done" })
    } else if (type === "transcribe") {
      const output = await recognizer(payload.audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: "word",
        language: payload.language || null,
        chunk_callback: () => post({ type: "chunk" }),
      })
      post({ id, type: "done", result: output })
    } else if (type === "translate") {
      const result = await translator(payload.texts, {
        src_lang: payload.src,
        tgt_lang: payload.tgt,
      })
      post({ id, type: "done", result })
    } else {
      post({ id, type: "error", error: `Unknown message type: ${type}` })
    }
  } catch (err: any) {
    post({ id, type: "error", error: String(err?.message || err) })
  }
}
