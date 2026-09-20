/**
 * RateLimit-Shield - High-Performance Distributed Rate Limiting Engine
 * Author: Ali Nurettin Demir (@alinurettin)
 * 
 * Algorithms:
 * 1. Token Bucket with Continuous Fractional Refill
 * 2. Sliding Window Counter with Sub-Millisecond Log Pruning
 */

class TokenBucket {
  constructor(capacity = 10, refillRatePerSecond = 2) {
    this.capacity = capacity;
    this.refillRatePerMs = refillRatePerSecond / 1000;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  refill(now = Date.now()) {
    const elapsed = Math.max(0, now - this.lastRefill);
    const addedTokens = elapsed * this.refillRatePerMs;
    this.tokens = Math.min(this.capacity, this.tokens + addedTokens);
    this.lastRefill = now;
  }

  consume(tokens = 1, now = Date.now()) {
    this.refill(now);

    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      const deficit = this.capacity - this.tokens;
      const resetMs = Math.ceil(deficit / this.refillRatePerMs);
      return {
        allowed: true,
        remaining: Math.floor(this.tokens),
        exactTokens: this.tokens,
        resetMs: Math.max(0, resetMs),
        retryAfterSec: 0
      };
    } else {
      const deficit = tokens - this.tokens;
      const retryAfterMs = Math.ceil(deficit / this.refillRatePerMs);
      const resetMs = Math.ceil((this.capacity - this.tokens) / this.refillRatePerMs);
      return {
        allowed: false,
        remaining: 0,
        exactTokens: this.tokens,
        resetMs: Math.max(0, resetMs),
        retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000))
      };
    }
  }

  reset(now = Date.now()) {
    this.tokens = this.capacity;
    this.lastRefill = now;
  }
}

class SlidingWindow {
  constructor(windowSizeMs = 60000, maxRequests = 60) {
    this.windowSizeMs = windowSizeMs;
    this.maxRequests = maxRequests;
    this.timestamps = [];
  }

  prune(now = Date.now()) {
    const threshold = now - this.windowSizeMs;
    while (this.timestamps.length > 0 && this.timestamps[0] <= threshold) {
      this.timestamps.shift();
    }
  }

  consume(now = Date.now()) {
    this.prune(now);

    if (this.timestamps.length < this.maxRequests) {
      this.timestamps.push(now);
      const remaining = this.maxRequests - this.timestamps.length;
      const oldest = this.timestamps[0];
      const resetMs = Math.max(0, (oldest + this.windowSizeMs) - now);
      return {
        allowed: true,
        remaining,
        count: this.timestamps.length,
        resetMs,
        retryAfterSec: 0
      };
    } else {
      const oldest = this.timestamps[0];
      const retryAfterMs = Math.max(0, (oldest + this.windowSizeMs) - now);
      return {
        allowed: false,
        remaining: 0,
        count: this.timestamps.length,
        resetMs: retryAfterMs,
        retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000))
      };
    }
  }

  reset() {
    this.timestamps = [];
  }
}

class RateLimiterEngine {
  constructor(options = {}) {
    this.algorithm = options.algorithm || 'TOKEN_BUCKET'; // 'TOKEN_BUCKET' | 'SLIDING_WINDOW'
    this.capacity = options.capacity || 10;
    this.refillRate = options.refillRate || 2; // tokens per second
    this.windowSizeMs = options.windowSizeMs || 60000;
    this.maxRequests = options.maxRequests || 60;
    this.staleTimeoutMs = options.staleTimeoutMs || 300000; // 5 mins inactivity cleanup

    this.clients = new Map(); // key -> { limiter, lastSeen }
    this.whitelist = new Set(options.whitelist || ['127.0.0.1', 'localhost']);
    this.blacklist = new Set(options.blacklist || []);

    this.metrics = {
      totalRequests: 0,
      allowedRequests: 0,
      blockedRequests: 0,
      startTime: Date.now()
    };
  }

  _getOrCreateClient(clientId) {
    let entry = this.clients.get(clientId);
    const now = Date.now();

    if (!entry) {
      const limiter = this.algorithm === 'SLIDING_WINDOW'
        ? new SlidingWindow(this.windowSizeMs, this.maxRequests)
        : new TokenBucket(this.capacity, this.refillRate);

      entry = { limiter, lastSeen: now, algorithm: this.algorithm };
      this.clients.set(clientId, entry);
    } else {
      entry.lastSeen = now;
    }
    return entry;
  }

  check(clientId, cost = 1, now = Date.now()) {
    this.metrics.totalRequests++;

    // Blacklist check
    if (this.blacklist.has(clientId)) {
      this.metrics.blockedRequests++;
      return {
        allowed: false,
        remaining: 0,
        resetMs: 3600000,
        retryAfterSec: 3600,
        reason: 'BLACKLISTED',
        algorithm: this.algorithm
      };
    }

    // Whitelist check
    if (this.whitelist.has(clientId)) {
      this.metrics.allowedRequests++;
      return {
        allowed: true,
        remaining: 999999,
        resetMs: 0,
        retryAfterSec: 0,
        reason: 'WHITELISTED',
        algorithm: this.algorithm
      };
    }

    const client = this._getOrCreateClient(clientId);
    const result = client.limiter.consume(cost, now);

    if (result.allowed) {
      this.metrics.allowedRequests++;
    } else {
      this.metrics.blockedRequests++;
    }

    return {
      ...result,
      clientId,
      algorithm: this.algorithm,
      capacity: this.algorithm === 'TOKEN_BUCKET' ? this.capacity : this.maxRequests
    };
  }

  resetClient(clientId) {
    const client = this.clients.get(clientId);
    if (client) {
      client.limiter.reset();
      return true;
    }
    return false;
  }

  cleanupStaleClients(now = Date.now()) {
    let evicted = 0;
    for (const [id, client] of this.clients.entries()) {
      if (now - client.lastSeen > this.staleTimeoutMs) {
        this.clients.delete(id);
        evicted++;
      }
    }
    return evicted;
  }

  updateConfig(newConfig = {}) {
    if (newConfig.algorithm) this.algorithm = newConfig.algorithm;
    if (newConfig.capacity !== undefined) this.capacity = Number(newConfig.capacity);
    if (newConfig.refillRate !== undefined) this.refillRate = Number(newConfig.refillRate);
    if (newConfig.windowSizeMs !== undefined) this.windowSizeMs = Number(newConfig.windowSizeMs);
    if (newConfig.maxRequests !== undefined) this.maxRequests = Number(newConfig.maxRequests);

    // Re-initialize clients with new parameters
    this.clients.clear();
  }

  getStats() {
    const total = this.metrics.totalRequests;
    const dropRate = total > 0 ? ((this.metrics.blockedRequests / total) * 100).toFixed(2) : '0.00';
    return {
      totalRequests: this.metrics.totalRequests,
      allowedRequests: this.metrics.allowedRequests,
      blockedRequests: this.metrics.blockedRequests,
      dropRatePercent: Number(dropRate),
      activeClients: this.clients.size,
      algorithm: this.algorithm,
      config: {
        capacity: this.capacity,
        refillRatePerSec: this.refillRate,
        windowSizeMs: this.windowSizeMs,
        maxRequests: this.maxRequests
      },
      uptimeSeconds: Math.floor((Date.now() - this.metrics.startTime) / 1000)
    };
  }
}

module.exports = { TokenBucket, SlidingWindow, RateLimiterEngine };