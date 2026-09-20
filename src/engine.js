class TokenBucketLimiter {
  constructor(capacity = 5, refillRatePerSec = 1) {
    this.capacity = capacity;
    this.refillRate = refillRatePerSec;
    this.clients = new Map();
  }
  consume(clientId, cost = 1) {
    const now = Date.now();
    let client = this.clients.get(clientId);
    if (!client) {
      client = { tokens: this.capacity, lastRefill: now };
      this.clients.set(clientId, client);
    } else {
      const elapsed = (now - client.lastRefill) / 1000;
      client.tokens = Math.min(this.capacity, client.tokens + (elapsed * this.refillRate));
      client.lastRefill = now;
    }
    if (client.tokens >= cost) {
      client.tokens -= cost;
      return { allowed: true, remaining: parseFloat(client.tokens.toFixed(2)), resetSeconds: 0 };
    } else {
      const waitTime = (cost - client.tokens) / this.refillRate;
      return { allowed: false, remaining: parseFloat(client.tokens.toFixed(2)), resetSeconds: parseFloat(waitTime.toFixed(2)) };
    }
  }
}
module.exports = TokenBucketLimiter;