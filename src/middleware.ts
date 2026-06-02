import { defineMiddleware } from "astro:middleware"
import { languages, defaultLang } from "./i18n/ui"

const LOCALES = Object.keys(languages)
// Name of the cookie that stores an explicit, user-made language choice (set by
// the footer switcher). When present it always wins over browser detection.
const LOCALE_COOKIE = "locale"

// Detect the visitor's language on the bare root and redirect to the matching
// localized page. This only runs for on-demand routes (the home is rendered
// on-demand); prerendered pages like `/es/` are served straight from the CDN
// and never hit this middleware.
export const onRequest = defineMiddleware((context, next) => {
  if (context.url.pathname !== "/") return next()

  const chosen = context.cookies.get(LOCALE_COOKIE)?.value
  // An explicit choice takes priority; otherwise fall back to the browser's
  // Accept-Language (already matched against our configured locales by Astro).
  const target =
    chosen && LOCALES.includes(chosen) ? chosen : context.preferredLocale

  if (target && target !== defaultLang && LOCALES.includes(target)) {
    return context.redirect(`/${target}/`, 302)
  }

  return next()
})
