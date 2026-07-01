/**
 * Links back to the marketing site (dashboard / sign-in) and the donation page.
 *
 * The controller is served at whipdesk.com/app — its own URL carries NO locale — so it derives
 * the user's site language from what the dashboard persisted (localStorage `wd-locale`), then the
 * browser languages, then English. Only ACTIVE locales are used so we never bounce to an
 * ungenerated /xx/ page (static export => 404). Keep ACTIVE_LOCALES in sync with
 * the web project's i18n locale config.
 */
const ACTIVE_LOCALES = ["en"] as const;
const DEFAULT_LOCALE = "en";

/** Best guess at the user's site locale (stored choice → browser language → English). */
export function siteLocale(): string {
  try {
    const stored = localStorage.getItem("wd-locale");
    if (stored && (ACTIVE_LOCALES as readonly string[]).includes(stored)) return stored;
  } catch {
    /* storage may be unavailable */
  }
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const lang of langs) {
    const base = (lang || "").toLowerCase().split("-")[0] ?? "";
    if ((ACTIVE_LOCALES as readonly string[]).includes(base)) return base;
  }
  return DEFAULT_LOCALE;
}

/** Empty (relative) when already on whipdesk.com; the production origin otherwise. */
function siteBase(): string {
  return location.hostname.endsWith("whipdesk.com") ? "" : "https://whipdesk.com";
}

/** Locale-aware dashboard URL, e.g. `/en/dashboard/`. */
export function dashboardUrl(): string {
  return `${siteBase()}/${siteLocale()}/dashboard/`;
}

/** Locale-aware sign-in URL with an optional post-login `next` path. */
export function signInUrl(next?: string): string {
  const q = next ? `?next=${encodeURIComponent(next)}` : "";
  return `${siteBase()}/${siteLocale()}/sign-in/${q}`;
}

/**
 * Donation link. TURN relay traffic costs real money; the connection dialog invites support here.
 * TEST-mode Stripe link for now — swap for the live link before launch.
 */
export const DONATE_URL = "https://donate.stripe.com/6oU5kE19N5v35652n88so01";

// Where users report issues / share ideas. Kept in sync with the marketing site's src/lib/links.ts.
export const GITHUB_URL = "https://github.com/BinaryBananaLLC/WhipDesk/";
export const REDDIT_URL = "https://www.reddit.com/r/WhipDesk/";
