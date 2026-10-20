// ─── Edit this to add/rename referral sources ─────────────────────────────────
// Same keys as hi-sg (lib/referral-sources.ts), so one set of links works on every site.
// key   = the URL query param (e.g. "l" matches "?l" or "?l=anything")
// value = display name, bolded in the Discord message
export const REFERRAL_SOURCES: Record<string, string> = {
  c: "Cover Letter",
  l: "LinkedIn",
  r: "Resume",
  t: "Twitter/X",
  e: "Email",
  g: "GitHub",
  z: "Resume",
}

// utm_source values that name a referral source. Anything not listed here (and not an
// AI assistant, see ./ai-assistants.ts) still shows as "CUSTOM REFERRAL" with its raw params.
//   ?utm_source=resume_rl → "Resume" (the link on Richard's resume)
export const UTM_SOURCES: Record<string, string> = {
  resume_rl: "Richard's Resume",
}
// ──────────────────────────────────────────────────────────────────────────────
