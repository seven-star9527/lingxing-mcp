function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class EndpointRateLimiter {
  constructor({ now = () => Date.now(), wait = sleep } = {}) {
    this.now = now;
    this.wait = wait;
    this.queues = new Map();
    this.nextAllowedAt = new Map();
  }

  async schedule(endpointId, requestsPerSecond = 1) {
    const rate = Math.max(0.1, Math.min(100, Number(requestsPerSecond) || 1));
    const interval = Math.ceil(1000 / rate);
    const previous = this.queues.get(endpointId) ?? Promise.resolve();
    const current = previous.then(async () => {
      const next = this.nextAllowedAt.get(endpointId) ?? 0;
      const delay = Math.max(0, next - this.now());
      if (delay > 0) await this.wait(delay);
      this.nextAllowedAt.set(endpointId, this.now() + interval);
    });
    this.queues.set(endpointId, current.catch(() => {}));
    await current;
  }
}
