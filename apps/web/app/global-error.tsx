"use client";

/**
 * global-error.tsx — the whole app failed to render. Next ships a synthetic
 * one that cannot survive this app's per-request headers() in prerender, so
 * the real page lives here: it never names a cause we have not seen, and it
 * offers only routes that exist.
 */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          background: "#0a0a0a",
          color: "#f2f2f0",
          fontFamily: "system-ui, sans-serif",
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 20,
          padding: 24,
          margin: 0,
        }}
      >
        <p
          style={{
            fontSize: 11,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: "#8a8a85",
            margin: 0,
          }}
        >
          Something broke
        </p>
        <h1 style={{ fontSize: 25.5, fontWeight: 600, letterSpacing: "-0.03em", margin: 0 }}>
          The app failed to render this page.
        </h1>
        <p style={{ maxWidth: 420, textAlign: "center", fontSize: 14, color: "#a0a09c", margin: 0 }}>
          Nothing was deleted or hidden — this request failed. Try again, and if
          it persists, the address below is the safe way back in.
        </p>
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              background: "#e6e4dd",
              color: "#0a0a0a",
              border: "none",
              borderRadius: 2,
              padding: "10px 20px",
              fontSize: 13.5,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          <a href="/" style={{ color: "#a0a09c", fontSize: 13.5, textDecoration: "underline" }}>
            Go home
          </a>
        </div>
      </body>
    </html>
  );
}
