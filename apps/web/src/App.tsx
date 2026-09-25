import { useState, type FormEvent } from 'react';
import { scanDomain } from './api';
import type { ScanResult } from './types';
import './styles.css';

const statusLabels: Record<ScanResult['status'], string> = {
  healthy: 'Healthy',
  needs_attention: 'Needs attention',
  missing: 'Records missing',
  error: 'Scan error',
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function ResultView({ result }: { result: ScanResult }) {
  return (
    <section className="result" aria-live="polite">
      <div className="result-heading">
        <div>
          <h2>{result.domain}</h2>
          <p>Checked {formatTime(result.scannedAt)}</p>
        </div>
        <div className="score">
          <strong>{result.score}</strong>
          <span>/ 100</span>
        </div>
      </div>

      <p className={`status ${result.status}`}>{statusLabels[result.status]}</p>

      <div className="record-grid">
        <div className="record">
          <span>DMARC</span>
          <strong>{result.dmarc.status === 'found' ? `Policy: ${result.dmarc.policy}` : 'Not found'}</strong>
        </div>
        <div className="record">
          <span>SPF</span>
          <strong>{result.spf.status === 'found' ? `${result.spf.lookupCount} DNS lookups` : 'Not found'}</strong>
        </div>
        <div className="record">
          <span>DKIM</span>
          <strong>{result.dkim.status === 'found' ? `${result.dkim.selectors.length} selector(s)` : 'Not found'}</strong>
        </div>
        <div className="record">
          <span>MX</span>
          <strong>{result.mx.status === 'found' ? `${result.mx.records.length} mail server(s)` : 'Not found'}</strong>
        </div>
      </div>

      <div className="score-explanation">
        <h3>Why this score?</h3>
        <p>Started at {result.scoreBreakdown.base} points.</p>
        {result.scoreBreakdown.factors.length === 0 ? <p>No deductions were found.</p> : null}
        {result.scoreBreakdown.factors.map((factor) => (
          <div className="score-factor" key={factor.code}>
            <div>
              <strong>{factor.label}</strong>
              <span>{factor.description}</span>
            </div>
            <b>{factor.points}</b>
          </div>
        ))}
      </div>

      <div className="findings">
        <h3>Findings</h3>
        {result.issues.length === 0 ? <p>No immediate issues were found.</p> : null}
        {result.issues.map((issue) => (
          <article className={`finding ${issue.severity}`} key={issue.code}>
            <strong>{issue.title}</strong>
            <p>{issue.message}</p>
            {issue.recommendation ? <small>{issue.recommendation}</small> : null}
          </article>
        ))}
      </div>
    </section>
  );
}

export default function App() {
  const [domain, setDomain] = useState('');
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setResult(null);
    setLoading(true);

    try {
      setResult(await scanDomain(domain));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'The scan could not be completed.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page">
      <header className="header">
        <strong>DMARC Harbor</strong>
        <span>Development preview</span>
      </header>

      <section className="intro">
        <p className="label">Public DNS scanner</p>
        <h1>Check a domain&apos;s email authentication.</h1>
        <p>This temporary screen is intentionally functional. The visual design can be replaced later without changing the API.</p>
      </section>

      <form className="form" onSubmit={handleSubmit}>
        <label htmlFor="domain">Domain</label>
        <div className="form-row">
          <input
            id="domain"
            name="domain"
            type="text"
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            placeholder="example.com"
            required
          />
          <button type="submit" disabled={loading}>
            {loading ? 'Scanning…' : 'Scan domain'}
          </button>
        </div>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <small>No account required. The current scanner reads public DNS records only.</small>
      </form>

      {result ? <ResultView result={result} /> : null}
    </main>
  );
}
