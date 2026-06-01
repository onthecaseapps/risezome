/**
 * Pull a conference URL + platform from a Google Calendar event.
 *
 * Two extraction paths, tried in order:
 *
 *   1. Structured: `conferenceData.entryPoints[]` filtered to
 *      `entryPointType === 'video'`. This is the canonical Google source —
 *      events created from the Calendar UI populate it correctly.
 *
 *   2. Regex fallback: scan the `location` then `description` strings
 *      for Zoom / Meet URLs. Catches events where the conference was
 *      pasted in by hand (very common) or where conferenceData is absent
 *      (third-party calendar imports).
 *
 * Platform detection precedence:
 *   - `conferenceData.conferenceSolution.key.type`:
 *       `hangoutsMeet`     → 'meet'
 *       `addOn`            → look at conferenceSolution.name; "Zoom Meeting" → 'zoom'
 *   - URL pattern:
 *       *.zoom.us, *.zoom.com               → 'zoom'
 *       meet.google.com                     → 'meet'
 *       *.webex.com, teams.microsoft.com    → 'other'
 *   - Anything else with a URL              → 'other'
 *   - No URL at all                         → null
 */

export interface GoogleEntryPoint {
  entryPointType?: string;
  uri?: string;
  label?: string;
}

export interface GoogleConferenceData {
  entryPoints?: GoogleEntryPoint[];
  conferenceSolution?: {
    key?: { type?: string };
    name?: string;
  };
}

export interface GoogleEventShape {
  conferenceData?: GoogleConferenceData;
  location?: string;
  description?: string;
}

export type Platform = 'zoom' | 'meet' | 'other';

export interface ConferenceInfo {
  url: string | null;
  platform: Platform | null;
}

export function extractConference(event: GoogleEventShape): ConferenceInfo {
  // Path 1: structured conferenceData
  const cd = event.conferenceData;
  if (cd !== undefined) {
    const videoEntry = (cd.entryPoints ?? []).find(
      (e) => e.entryPointType === 'video' && typeof e.uri === 'string' && e.uri.length > 0,
    );
    if (videoEntry?.uri !== undefined) {
      const platform = platformFromConferenceData(cd) ?? platformFromUrl(videoEntry.uri);
      return { url: videoEntry.uri, platform };
    }
  }

  // Path 2: regex fallback over location + description
  const candidates: string[] = [];
  if (typeof event.location === 'string') candidates.push(event.location);
  if (typeof event.description === 'string') candidates.push(event.description);

  for (const text of candidates) {
    const url = findMeetingUrl(text);
    if (url !== null) {
      return { url, platform: platformFromUrl(url) };
    }
  }

  return { url: null, platform: null };
}

function platformFromConferenceData(cd: GoogleConferenceData): Platform | null {
  const type = cd.conferenceSolution?.key?.type;
  if (type === 'hangoutsMeet') return 'meet';
  if (type === 'addOn') {
    const name = (cd.conferenceSolution?.name ?? '').toLowerCase();
    if (name.includes('zoom')) return 'zoom';
  }
  return null;
}

function platformFromUrl(url: string): Platform {
  const lower = url.toLowerCase();
  if (/\bzoom\.(us|com)\b/.test(lower)) return 'zoom';
  if (/\bmeet\.google\.com\b/.test(lower)) return 'meet';
  return 'other';
}

// Conservative URL regex. We accept https + http but ignore mailto/tel.
// The match group is `https?://[^\s]+` trimmed of trailing punctuation
// that often gets eaten by sentence-final markers.
const URL_RE = /https?:\/\/[^\s<>"']+/gi;

function findMeetingUrl(text: string): string | null {
  const matches = text.match(URL_RE);
  if (matches === null) return null;
  // Prefer zoom/meet URLs over generic ones. Even within a description
  // that includes both an agenda doc link and a Zoom link, we want the
  // conference URL.
  let fallback: string | null = null;
  for (const raw of matches) {
    const url = trimTrailingPunct(raw);
    const platform = platformFromUrl(url);
    if (platform === 'zoom' || platform === 'meet') return url;
    if (fallback === null && looksLikeConferenceUrl(url)) fallback = url;
  }
  return fallback;
}

const TRAILING_PUNCT_RE = /[.,;:!?)>\]}]+$/;
function trimTrailingPunct(url: string): string {
  return url.replace(TRAILING_PUNCT_RE, '');
}

function looksLikeConferenceUrl(url: string): boolean {
  // Catches Teams, Webex, Whereby, Around, Jitsi — anything that looks
  // like a video call URL by hostname. Excludes docs/calendars/etc.
  return /(teams|webex|whereby|around|jit\.si|jitsi|gotomeeting|bluejeans)/i.test(url);
}
