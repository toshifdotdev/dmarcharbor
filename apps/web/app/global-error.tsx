"use client";

/**
 * global-error.tsx — the whole app failed to render. Next ships a synthetic
 * one that cannot survive this app's per-request headers() in prerender, so
 * the real page lives here: it never names a cause we have not seen, and it
 * offers only routes that exist.
 *
 * It replaces the root layout, so no stylesheet or font is loaded: the Routes
 * look is spelled out inline (white ground, ink, a pill button).
 */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          background: "#ffffff",
          color: "#15171b",
          fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "center",
          gap: 18,
          padding: "24px max(24px, calc(50vw - 300px))",
          margin: 0,
        }}
      >
        <p style={{ fontSize: 14, fontWeight: 600, color: "#d9342b", margin: 0 }}>Something broke</p>
        <h1 style={{ fontSize: 34, fontWeight: 760, lineHeight: 1.05, letterSpacing: "-0.03em", margin: 0 }}>
          The app failed to render this page.
        </h1>
        <p style={{ maxWidth: 460, fontSize: 16, lineHeight: 1.5, color: "#41454d", margin: 0 }}>
          Nothing was deleted or hidden: this request failed. Try again, and if it persists, the address below is the
          safe way back in.
        </p>
        <div style={{ display: "flex", gap: 18, alignItems: "center", marginTop: 6 }}>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              background: "#15171b",
              color: "#ffffff",
              border: "none",
              borderRadius: 999,
              height: 44,
              padding: "0 24px",
              fontSize: 15,
              fontWeight: 650,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          <a href="/" style={{ color: "#15171b", fontSize: 15, fontWeight: 600, textDecoration: "underline" }}>
            Go home
          </a>
        </div>
      </body>
    </html>
  );
}
