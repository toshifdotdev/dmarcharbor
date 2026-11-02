# Albert Sans, self-hosted

For the two pages that cannot use the root layout's `next/font` face: `app/global-error.tsx` (the root layout itself failed) and `lib/link-error-page.ts` (a route handler's plain HTML page). Both declare an `@font-face` pointing here, with `font-display: swap` and a system fallback, so a missing file only means a system face.

| File | Weight | Source |
|---|---|---|
| `AlbertSans-Regular.woff2` | 400 | Albert Sans 1.31 static instance, `apps/api/assets/fonts/AlbertSans-Regular.ttf` |
| `AlbertSans-Bold.woff2` | 700, declared for 600 to 800 | Albert Sans 1.31 static instance, `apps/api/assets/fonts/AlbertSans-Bold.ttf` |

Converted to WOFF2 with fontTools; the glyph set is unchanged (not subset), so an agency name in Latin Extended still has its letters. Albert Sans is under the SIL Open Font License 1.1, `OFL-AlbertSans.txt`.

`proxy.ts` allows same-origin fonts (`font-src 'self'`), and `/fonts/*` is neither a vendor route nor an icon path, so it is served as is on every host.
