/**
 * RateLimit-Shield - Production Reverse Proxy & API Gateway
 * Author: Ali Nurettin Demir (@alinurettin)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { RateLimiterEngine } = require('./engine');

const engine = new RateLimiterEngine({
  algorithm: process.env.RATE_LIMIT_ALGO || 'TOKEN_BUCKET',
  capacity: parseInt(process.env.RATE_LIMIT_CAPACITY, 10) || 10,
  refillRate: parseFloat(process.env.RATE_LIMIT_REFILL) || 2,
  whitelist: [] // empty default so local tests test rate limiting unless explicitly whitelisted
});

const PORT = parseInt(process.env.PORT, 10) || 6008;
const publicDir = path.join(__dirname, '..', 'public');
const startTime = Date.now();

function extractClientKey(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  const apiKey = req.headers['x-api-key'] || req.headers['authorization'];
  if (apiKey) {
    return apiKey.replace(/^Bearer\s+/i, '').trim();
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

function requestHandler(req, res) {
  const reqUrl = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = reqUrl.pathname;

  // Global CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Client-ID, Authorization'
    });
    return res.end();
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    // 1. Health Status
    if (pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({
        status: 'UP',
        service: 'RateLimit-Shield',
        uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
        timestamp: new Date().toISOString()
      }));
    }

    // 2. Metrics & Engine Stats
    if (pathname === '/api/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({
        success: true,
        service: 'RateLimit-Shield',
        stats: engine.getStats()
      }));
    }

    // 3. Test Rate Limit Check Endpoint
    if (pathname === '/api/check') {
      const clientKey = req.headers['x-client-id'] || extractClientKey(req);
      let cost = 1;
      if (req.method === 'POST') {
        try {
          const parsed = JSON.parse(body || '{}');
          if (parsed.cost) cost = Number(parsed.cost);
          if (parsed.clientId) clientKey = parsed.clientId;
        } catch (e) {}
      }

      const decision = engine.check(clientKey, cost);

      // Standard IETF & RFC 6585 Headers
      const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'X-RateLimit-Limit': String(decision.capacity || 10),
        'X-RateLimit-Remaining': String(decision.remaining),
        'X-RateLimit-Reset': String(Math.ceil(decision.resetMs / 1000))
      };

      if (!decision.allowed) {
        headers['Retry-After'] = String(decision.retryAfterSec);
        res.writeHead(429, headers);
        return res.end(JSON.stringify({
          error: 'Too Many Requests',
          message: `Rate limit exceeded for client ${clientKey}. Retry after ${decision.retryAfterSec}s.`,
          retryAfterSec: decision.retryAfterSec,
          remaining: 0,
          resetMs: decision.resetMs
        }));
      }

      res.writeHead(200, headers);
      return res.end(JSON.stringify({
        allowed: true,
        client: clientKey,
        remaining: decision.remaining,
        resetMs: decision.resetMs,
        algorithm: decision.algorithm
      }));
    }

    // 4. Admin Reset Endpoint
    if (req.method === 'POST' && pathname === '/api/reset') {
      try {
        const parsed = JSON.parse(body || '{}');
        const targetClient = parsed.clientId || extractClientKey(req);
        const resetSuccess = engine.resetClient(targetClient);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ success: true, client: targetClient, reset: resetSuccess }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    // 5. Admin Config Endpoint
    if (req.method === 'POST' && pathname === '/api/config') {
      try {
        const parsed = JSON.parse(body || '{}');
        engine.updateConfig(parsed);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ success: true, newConfig: engine.getStats().config }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    // 6. Static Web UI Files
    let filePath = path.join(publicDir, pathname === '/' ? 'index.html' : pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8'
      };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
      return res.end(fs.readFileSync(filePath));
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  });
}

function startServer(portToUse = PORT, callback) {
  const server = http.createServer(requestHandler);
  server.listen(portToUse, callback);
  return server;
}

if (require.main === module) {
  startServer(PORT, () => {
    console.log(`🛡️ RateLimit-Shield live at http://localhost:${PORT}`);
  });
}

module.exports = { startServer, engine };
