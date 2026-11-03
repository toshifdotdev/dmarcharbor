import { describe, expect, it } from 'vitest';
import { HTML_LIMITED_BOT_UA_RE } from 'next/dist/shared/lib/router/utils/html-bots.js';
import nextConfig from '../next.config';

/**
 * htmlLimitedBots replaces Next's default list rather than adding to it, so
 * next.config.ts repeats the default and appends the AI fetchers. These fail
 * when a Next upgrade changes the default, or when an AI fetcher stops getting
 * its <title>, description and canonical in <head>.
 */

const bots = nextConfig.htmlLimitedBots as RegExp;

describe('htmlLimitedBots', () => {
  it("starts with Next's own default list, unchanged", () => {
    expect(bots).toBeInstanceOf(RegExp);
    expect(bots.source.startsWith(`${HTML_LIMITED_BOT_UA_RE.source}|`)).toBe(true);
  });

  it('matches the AI fetchers that read raw HTML', () => {
    for (const ua of [
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
      'Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
      'Claude-SearchBot/1.0',
      'Claude-User/1.0',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
      'Perplexity-User/1.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1)',
      'CCBot/2.0 (https://commoncrawl.org/faq/)',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'facebookexternalhit/1.1',
    ]) {
      expect(new RegExp(bots.source, 'i').test(ua), ua).toBe(true);
    }
  });

  it('leaves an ordinary browser on streamed metadata', () => {
    const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
    expect(new RegExp(bots.source, 'i').test(chrome)).toBe(false);
  });
});
