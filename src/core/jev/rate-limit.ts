/**
 * Client-side limiter for requests per minute and tokens per second, so bursts of
 * fan-out calls queue locally instead of bouncing off 429s.
 */
export class RateLimiter {
  private requests: number[] = [];
  private tokens: { at: number; n: number }[] = [];
  private readonly rpm: () => number;
  private readonly tps: () => number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: {
    requestsPerMinute: () => number;
    tokensPerSecond: () => number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.rpm = opts.requestsPerMinute;
    this.tps = opts.tokensPerSecond;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Waits until a request of `tokenCount` tokens fits, then records it. */
  async acquire(tokenCount: number): Promise<void> {
    for (;;) {
      const t = this.now();
      this.requests = this.requests.filter((x) => t - x < 60_000);
      this.tokens = this.tokens.filter((x) => t - x.at < 1000);
      const usedTokens = this.tokens.reduce((s, x) => s + x.n, 0);
      let wait = 0;
      if (this.requests.length >= this.rpm()) wait = Math.max(wait, 60_000 - (t - this.requests[0]));
      if (this.tokens.length > 0 && usedTokens + tokenCount > this.tps()) wait = Math.max(wait, 1000 - (t - this.tokens[0].at));
      if (wait <= 0) {
        this.requests.push(t);
        this.tokens.push({ at: t, n: tokenCount });
        return;
      }
      await this.sleep(Math.ceil(wait));
    }
  }
}
