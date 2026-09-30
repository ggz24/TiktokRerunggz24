// Set to the same value as `basePath` in next.config.ts (e.g. NEXT_PUBLIC_BASE_PATH=/live
// when the app is served under https://ggz24.com/live). Client-side fetch() calls do not
// get Next.js's automatic basePath rewriting, so every same-origin API call must go through
// apiPath() to still resolve when the app is not served from the domain root.
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export function apiPath(path: string): string {
  return `${BASE_PATH}${path}`;
}
