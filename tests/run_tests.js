/**
 * RateLimit-Shield - Exhaustive Multi-Scenario Verification Suite
 * Author: Ali Nurettin Demir (@alinurettin)
 * 
 * Verifies:
 * - Algorithmic precision (Token Bucket & Sliding Window)
 * - Fractional time refill mechanics
 * - Multi-tenant client isolation
 * - Ephemeral HTTP reverse proxy integration
 * - RFC 6585 rate limit headers and 429 Too Many Requests status
 */

const assert = require('assert');
const http = require('http');
const { TokenBucket, SlidingWindow, RateLimiterEngine } = require('../src/engine');
const { startServer } = require('../src/index');

console.log('================================================================');
console.log('🛡️  RateLimit-Shield: Exhaustive Multi-Scenario Verification Suite');
console.log('================================================================\n');

let assertionCount = 0;
function check(cond, msg) {
  assert.ok(cond, msg);
  assertionCount++;
  console.log(`  ✓ [Assertion #${assertionCount}] ${msg}`);
}

// -------------------------------------------------------------
// SECTION 1: TokenBucket Algorithm Unit Tests
// -------------------------------------------------------------
console.log('[SECTION 1] Testing TokenBucket Mathematical Properties...');

const tb = new TokenBucket(10, 2); // 10 capacity, 2 tokens/sec
check(tb.tokens === 10, 'Initial token count matches capacity');
check(tb.capacity === 10, 'Capacity property is accurately recorded');

const c1 = tb.consume(3);
check(c1.allowed === true, 'Consuming 3 tokens within capacity is allowed');
check(c1.remaining === 7, 'Remaining tokens correctly decremented to 7');
check(c1.retryAfterSec === 0, 'Retry-After is 0 on allowed request');

const c2 = tb.consume(7);
check(c2.allowed === true, 'Consuming remaining 7 tokens is allowed');
check(c2.remaining === 0, 'Tokens depleted to exactly 0');

const c3 = tb.consume(1);
check(c3.allowed === false, 'Request rejected when bucket is completely empty');
check(c3.remaining === 0, 'Remaining stays at 0 when rejected');
check(c3.retryAfterSec >= 1, 'Retry-After indicates positive wait time');

// Fractional refill simulation
const now = Date.now();
tb.lastRefill = now - 1500; // Simulate 1.5 seconds elapsed -> 1.5s * 2 tokens/sec = 3 tokens refilled
tb.refill(now);
check(tb.tokens >= 2.9 && tb.tokens <= 3.1, 'Fractional continuous refill precisely restored ~3 tokens after 1.5s');

tb.reset(now);
check(tb.tokens === 10, 'Bucket reset restores tokens to full capacity');

// -------------------------------------------------------------
// SECTION 2: SlidingWindow Algorithm Unit Tests
// -------------------------------------------------------------
console.log('\n[SECTION 2] Testing SlidingWindow Log Pruning & Rate Control...');

const sw = new SlidingWindow(1000, 3); // 1000ms window, max 3 requests
const t0 = 100000;
const s1 = sw.consume(t0);
const s2 = sw.consume(t0 + 100);
const s3 = sw.consume(t0 + 200);
check(s1.allowed && s2.allowed && s3.allowed, 'First 3 requests within window successfully admitted');
check(s3.remaining === 0, 'Sliding window indicates 0 requests remaining');

const s4 = sw.consume(t0 + 300);
check(s4.allowed === false, '4th request within 1-second window rejected');
check(s4.retryAfterSec >= 1, 'Retry-After reflects duration until oldest request expires');

// Fast forward past oldest request
const s5 = sw.consume(t0 + 1100); // 1100ms later -> t0 has expired
check(s5.allowed === true, 'Request admitted after oldest window timestamp pruned');

// -------------------------------------------------------------
// SECTION 3: Multi-Tenant RateLimiterEngine Isolation
// -------------------------------------------------------------
console.log('\n[SECTION 3] Testing Multi-Tenant Isolation & Security Policies...');

const engine = new RateLimiterEngine({
  capacity: 2,
  refillRate: 1,
  whitelist: ['trusted-service'],
  blacklist: ['malicious-actor']
});

// Client A consumes all capacity
const ca1 = engine.check('client-A');
const ca2 = engine.check('client-A');
const ca3 = engine.check('client-A');
check(ca1.allowed && ca2.allowed, 'Client-A admitted up to quota');
check(ca3.allowed === false, 'Client-A throttled after exhausting quota');

// Client B is independent
const cb1 = engine.check('client-B');
check(cb1.allowed === true, 'Client-B is completely isolated and retains full quota');
check(cb1.remaining === 1, 'Client-B remaining tokens accurately tracked independently');

// Security policies
const cw = engine.check('trusted-service');
check(cw.allowed === true && cw.reason === 'WHITELISTED', 'Whitelisted entity bypasses rate limiting checks');

const cbl = engine.check('malicious-actor');
check(cbl.allowed === false && cbl.reason === 'BLACKLISTED', 'Blacklisted entity immediately dropped with security reason');

// Cleanup
engine.staleTimeoutMs = 50;
const evicted = engine.cleanupStaleClients(Date.now() + 100);
check(evicted >= 2, 'Stale client tracking memory successfully garbage collected');

// -------------------------------------------------------------
// SECTION 4: Live HTTP Server Ephemeral Integration Tests
// -------------------------------------------------------------
console.log('\n[SECTION 4] Testing Live HTTP Ephemeral Server Integration...');

const server = startServer(0, () => {
  const port = server.address().port;
  console.log(`  [HTTP] Ephemeral server active on port ${port}`);

  // Test 1: GET /api/health
  http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
    check(res.statusCode === 200, 'GET /api/health responds with HTTP 200 OK');
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      const json = JSON.parse(body);
      check(json.status === 'UP', 'Health response confirms service status is UP');

      // Test 2: Rate Limit Headers on /api/check
      http.get(`http://127.0.0.1:${port}/api/check`, { headers: { 'x-client-id': 'http-test-client' } }, (res2) => {
        check(res2.statusCode === 200, 'First check request returns HTTP 200 OK');
        check(res2.headers['x-ratelimit-limit'] !== undefined, 'Standard X-RateLimit-Limit header present');
        check(res2.headers['x-ratelimit-remaining'] !== undefined, 'Standard X-RateLimit-Remaining header present');

        // Test 3: Rapid flood to trigger HTTP 429
        const makeFlood = async () => {
          let lastRes;
          for (let i = 0; i < 15; i++) {
            lastRes = await new Promise(r => {
              http.get(`http://127.0.0.1:${port}/api/check`, { headers: { 'x-client-id': 'http-flood-client' } }, resDrop => {
                let d = '';
                resDrop.on('data', c => d += c);
                resDrop.on('end', () => r({ statusCode: resDrop.statusCode, headers: resDrop.headers, body: d }));
              });
            });
            if (lastRes.statusCode === 429) break;
          }
          return lastRes;
        };

        makeFlood().then((floodRes) => {
          check(floodRes.statusCode === 429, 'Excessive traffic triggers HTTP 429 Too Many Requests');
          check(floodRes.headers['retry-after'] !== undefined, 'HTTP 429 response includes RFC standard Retry-After header');
          const dropJson = JSON.parse(floodRes.body);
          check(dropJson.error === 'Too Many Requests', 'JSON payload contains explicit error description');

          // Test 4: Admin Reset
          const resetData = JSON.stringify({ clientId: 'http-flood-client' });
          const reqReset = http.request({
            hostname: '127.0.0.1',
            port,
            path: '/api/reset',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(resetData) }
          }, (resReset) => {
            check(resReset.statusCode === 200, 'POST /api/reset returns HTTP 200 OK');

            // Confirm client is admitted again after reset
            http.get(`http://127.0.0.1:${port}/api/check`, { headers: { 'x-client-id': 'http-flood-client' } }, (resPostReset) => {
              check(resPostReset.statusCode === 200, 'Client admitted immediately following bucket reset');

              // Close server & finish
              server.close(() => {
                console.log('\n================================================================');
                console.log(`🎉 ALL ${assertionCount} ASSERTIONS PASSED WITH 100% SUCCESS!`);
                console.log('================================================================\n');
                process.exit(0);
              });
            });
          });
          reqReset.write(resetData);
          reqReset.end();
        });
      });
    });
  });
});
