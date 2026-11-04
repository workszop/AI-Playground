/**
 * Kids-safe guard messages shown to the user. Main (the guard) and the renderer
 * (fail-closed fallbacks) both import them, so the texts cannot drift apart.
 */

export const KIDS_BLOCKED_MESSAGE =
  'Nie mogę w tym pomóc. Zapytaj o coś innego.\n\n' +
  "I can't help with that. Try asking about something else."

export const KIDS_GUARD_UNAVAILABLE_MESSAGE =
  'Filtr bezpieczeństwa nie działa, więc ta prośba została zablokowana.\n\n' +
  'The safety filter is not available, so this request was blocked.'

/** Shown when Stop ends a Text to Speech turn before its audio is ready. */
export const TTS_STOPPED_MESSAGE =
  'Zamiana tekstu na mowę została zatrzymana.\n\n' + 'Text to Speech was stopped.'
