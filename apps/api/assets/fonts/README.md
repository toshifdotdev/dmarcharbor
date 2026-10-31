# Fonts for the evidence pack

The compliance evidence pack (`src/services/trust/pack-pdf.ts`) is set in the same two families as the web app, embedded as subsets by pdfkit:

| File | Family | Source | Licence |
|---|---|---|---|
| `AlbertSans-Regular.ttf`, `AlbertSans-Medium.ttf`, `AlbertSans-Bold.ttf` | Albert Sans 1.31, static instances | [usted/Albert-Sans release v1.31](https://github.com/usted/Albert-Sans/releases/tag/v1.31) | SIL Open Font License 1.1, `OFL-AlbertSans.txt` |
| `AtkinsonHyperlegibleMono-Regular.ttf`, `AtkinsonHyperlegibleMono-Medium.ttf` | Atkinson Hyperlegible Mono | [googlefonts/atkinson-hyperlegible-next-mono](https://github.com/googlefonts/atkinson-hyperlegible-next-mono), `fonts/ttf` | SIL Open Font License 1.1, `OFL-AtkinsonHyperlegibleMono.txt` |

`src/services/trust/pdf-fonts.ts` finds this folder at `../../../assets/fonts` from its own module, which is `apps/api/assets/fonts` from both `src/` and `dist/`. The container needs the folder copied beside `dist`:

```dockerfile
COPY --from=build /repo/apps/api/assets ./apps/api/assets
```

If a file is missing or cannot be read, the pack falls back to the PDF standard faces (Helvetica and Courier) for that whole family and is still issued.
