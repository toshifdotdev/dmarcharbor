"use client";

/**
 * global-error.tsx — the root layout itself failed, so this replaces the whole
 * document. Next ships a synthetic one that cannot survive this app's
 * per-request headers() in prerender, so the real page lives here.
 *
 * It must work when everything else is broken, so it imports nothing: no
 * stylesheet, no next/font, no shared component, no brand lookup (any of those
 * may be what failed). The Routes look is spelled out inline: white ground,
 * ink type, the red bar that marks a failure, a pill button. The face is
 * Albert Sans from public/fonts (self-hosted, SIL OFL), declared in an inline
 * @font-face with font-display: swap, so if the file cannot be had the page
 * still reads in the system face. No name is shown, because the host's brand
 * cannot be read here and on an agency's domain the only right name is theirs.
 *
 * Try again calls `retry` (Next 16.3+), which re-fetches and re-renders;
 * `reset` would only re-render the same failed tree. The digest is the
 * reference support can find in the server log; the error's message is never
 * shown.
 */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  const raw =
    error && typeof error === "object" && "digest" in error ? (error as { digest?: unknown }).digest : undefined;
  const digest = typeof raw === "string" && /^[A-Za-z0-9_:-]{1,128}$/.test(raw) ? raw : null;

  return (
    <html lang="en">
      <body
        style={{
          background: "#ffffff",
          color: "#15171b",
          fontFamily: "'Albert Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "center",
          gap: 18,
          padding: "24px max(24px, calc(50vw - 300px))",
          margin: 0,
          boxSizing: "border-box",
        }}
      >
        <title>Something failed</title>
        {/* The bold file covers 600 to 800, so the 650 button and the 760
            headline use it rather than a synthesised bold. */}
        <style
          // A constant: set as raw CSS so no quote in it is ever escaped.
          dangerouslySetInnerHTML={{
            __html:
              '@font-face{font-family:"Albert Sans";src:url("/fonts/AlbertSans-Regular.woff2") format("woff2");font-weight:400;font-style:normal;font-display:swap}' +
              '@font-face{font-family:"Albert Sans";src:url("/fonts/AlbertSans-Bold.woff2") format("woff2");font-weight:600 800;font-style:normal;font-display:swap}',
          }}
        />
        <svg viewBox="0 0 132 30" width="132" height="30" aria-hidden="true" style={{ display: "block", overflow: "visible" }}>
          <path d="M12 15 H104" fill="none" stroke="#15171b" strokeWidth="5" strokeLinecap="round" />
          <circle cx="12" cy="15" r="7" fill="#ffffff" stroke="#15171b" strokeWidth="3" />
          <rect x="112" y="3" width="5" height="24" rx="1.5" fill="#d9342b" />
        </svg>
        <p role="alert" style={{ fontSize: 15, fontWeight: 700, color: "#d9342b", margin: 0 }}>
          Something failed on our side
        </p>
        <h1 style={{ fontSize: 36, fontWeight: 760, lineHeight: 0.96, letterSpacing: "-0.035em", margin: 0, textWrap: "balance" }}>
          This page could not be shown.
        </h1>
        <p style={{ maxWidth: 460, fontSize: 17, lineHeight: 1.5, color: "#41454d", margin: 0 }}>
          Nothing was deleted or changed: the app failed while drawing this page. Trying again is safe.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "center", marginTop: 6 }}>
          <button
            type="button"
            onClick={() => retry()}
            data-testid="state-retry"
            style={{
              background: "#15171b",
              color: "#ffffff",
              border: "none",
              borderRadius: 999,
              height: 44,
              padding: "0 24px",
              fontSize: 15,
              fontWeight: 650,
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          {/* A plain anchor, not next/link: a full load is the reliable way
              out of a broken root, and it imports nothing. */}
          <a href="/" style={{ color: "#15171b", fontSize: 16, fontWeight: 600, textDecoration: "underline" }}>
            Back to the start
          </a>
        </div>
        {digest ? (
          <p
            style={{
              maxWidth: 460,
              fontSize: 14,
              lineHeight: 1.5,
              color: "#6c717a",
              margin: "18px 0 0",
              paddingTop: 14,
              borderTop: "1px solid #e7e9ed",
            }}
          >
            If it keeps failing, send this reference to support: it finds this failure in the server log.
            <br />
            <span style={{ fontWeight: 600, color: "#41454d" }}>Reference</span>{" "}
            <span
              data-testid="error-reference"
              style={{
                fontFamily: "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace",
                color: "#15171b",
                userSelect: "all",
              }}
            >
              {digest}
            </span>
          </p>
        ) : null}
      </body>
    </html>
  );
}
