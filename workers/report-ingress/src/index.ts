interface Env {
  API_BASE_URL: string;
  REPORT_PATH?: string;
  MAX_ATTEMPTS?: string;
  REPORT_INGEST_SECRET: string;
}

const defaultReportPath = '/api/internal/reports/inbound';
const maximumAttempts = 5;

function getEndpoint(env: Env): string {
  if (!env.API_BASE_URL.startsWith('https://') && !env.API_BASE_URL.includes('localhost')) {
    throw new Error('API_BASE_URL must use HTTPS.');
  }

  return new URL(env.REPORT_PATH ?? defaultReportPath, env.API_BASE_URL).toString();
}

function getAttempts(env: Env): number {
  const parsed = Number(env.MAX_ATTEMPTS ?? 3);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return 3;
  }
  return Math.min(parsed, maximumAttempts);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function signPayload(payload: ArrayBuffer, secret: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const body = new Uint8Array(prefix.length + payload.byteLength);
  body.set(prefix);
  body.set(new Uint8Array(payload), prefix.length);
  const digest = await crypto.subtle.sign('HMAC', key, body);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function forwardEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const rawEmail = await new Response(message.raw).arrayBuffer();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await signPayload(rawEmail, env.REPORT_INGEST_SECRET, timestamp);
  const endpoint = getEndpoint(env);
  const attempts = getAttempts(env);
  let lastError = 'Unknown delivery error.';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'message/rfc822',
          'X-DMARC-Signature': signature,
          'X-DMARC-Timestamp': timestamp,
        },
        body: rawEmail,
      });

      if (response.ok) {
        return;
      }

      lastError = `DMARC Harbor returned HTTP ${response.status}.`;
      if (!isRetryableStatus(response.status)) {
        throw new Error(lastError);
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : lastError;
      if (attempt === attempts || (error instanceof Error && error.message.startsWith('DMARC Harbor returned HTTP 4'))) {
        break;
      }
    }

    if (attempt < attempts) {
      await sleep(500 * 2 ** (attempt - 1));
    }
  }

  console.error('DMARC report delivery failed', {
    recipient: message.to,
    attempts,
    error: lastError,
  });
  throw new Error(lastError);
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await forwardEmail(message, env);
  },
} satisfies ExportedHandler<Env>;
