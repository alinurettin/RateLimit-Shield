// RateLimit-Shield Client Controller & Visualizer
let maxCapacity = 10;
let currentTokens = 10;
let refillRate = 2; // tokens/sec

const logEntries = document.getElementById('logEntries');
const bucketFluid = document.getElementById('bucketFluid');
const tokensValue = document.getElementById('tokensValue');
const refillRateLabel = document.getElementById('refillRateLabel');

function addLog(msg, type = 'info') {
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEntries.appendChild(line);
  logEntries.scrollTop = logEntries.scrollHeight;
}

function updateBucketUI(remaining, capacity) {
  currentTokens = remaining;
  if (capacity) maxCapacity = capacity;
  const pct = Math.min(100, Math.max(0, (currentTokens / maxCapacity) * 100));
  bucketFluid.style.height = `${pct}%`;
  tokensValue.textContent = `${Math.floor(currentTokens)} / ${maxCapacity}`;

  if (pct > 50) {
    bucketFluid.style.background = 'linear-gradient(180deg, #60a5fa 0%, #2563eb 100%)';
  } else if (pct > 20) {
    bucketFluid.style.background = 'linear-gradient(180deg, #fcd34d 0%, #d97706 100%)';
  } else {
    bucketFluid.style.background = 'linear-gradient(180deg, #f87171 0%, #dc2626 100%)';
  }
}

// Continuous client-side bucket refill animation
setInterval(() => {
  if (currentTokens < maxCapacity) {
    currentTokens = Math.min(maxCapacity, currentTokens + (refillRate * 0.1));
    const pct = (currentTokens / maxCapacity) * 100;
    bucketFluid.style.height = `${pct}%`;
    tokensValue.textContent = `${Math.floor(currentTokens)} / ${maxCapacity}`;
  }
}, 100);

async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    if (data.stats) {
      document.getElementById('mTotal').textContent = data.stats.totalRequests;
      document.getElementById('mAllowed').textContent = data.stats.allowedRequests;
      document.getElementById('mBlocked').textContent = data.stats.blockedRequests;
      document.getElementById('mDropRate').textContent = `${data.stats.dropRatePercent}%`;
      document.getElementById('mClients').textContent = data.stats.activeClients;
      document.getElementById('mAlgo').textContent = data.stats.algorithm;
      if (data.stats.config) {
        maxCapacity = data.stats.config.capacity || 10;
        refillRate = data.stats.config.refillRatePerSec || 2;
        refillRateLabel.textContent = `+${refillRate.toFixed(1)} tokens / sec`;
      }
    }
  } catch (e) {}
}

async function sendRequest(clientId, cost = 1) {
  try {
    const res = await fetch('/api/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, cost })
    });

    const remainingHeader = res.headers.get('X-RateLimit-Remaining');
    const limitHeader = res.headers.get('X-RateLimit-Limit');
    const data = await res.json();

    if (res.status === 200) {
      addLog(`HTTP 200 OK | Client: ${clientId} | Remaining: ${remainingHeader}/${limitHeader}`, 'success');
      updateBucketUI(Number(remainingHeader), Number(limitHeader));
    } else if (res.status === 429) {
      addLog(`HTTP 429 TOO MANY REQUESTS | Client: ${clientId} | Retry-After: ${data.retryAfterSec}s`, 'error');
      updateBucketUI(0, maxCapacity);
    }
    fetchStats();
  } catch (err) {
    addLog(`Network Error: ${err.message}`, 'error');
  }
}

// Event Listeners
document.getElementById('btnSingle').addEventListener('click', () => {
  const client = document.getElementById('clientInput').value || 'client-demo';
  sendRequest(client, 1);
});

document.getElementById('btnBurst').addEventListener('click', async () => {
  const client = document.getElementById('clientInput').value || 'client-demo';
  addLog(`Triggering burst of 5 rapid requests...`, 'info');
  for (let i = 1; i <= 5; i++) {
    sendRequest(client, 1);
    await new Promise(r => setTimeout(r, 60));
  }
});

document.getElementById('btnFlood').addEventListener('click', async () => {
  const client = document.getElementById('clientInput').value || 'client-demo';
  addLog(`Simulating traffic flood of 15 requests...`, 'info');
  for (let i = 1; i <= 15; i++) {
    sendRequest(client, 1);
    await new Promise(r => setTimeout(r, 40));
  }
});

document.getElementById('btnReset').addEventListener('click', async () => {
  const client = document.getElementById('clientInput').value || 'client-demo';
  try {
    await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: client })
    });
    addLog(`Bucket manually reset for ${client}`, 'info');
    updateBucketUI(maxCapacity, maxCapacity);
    fetchStats();
  } catch (e) {}
});

document.getElementById('btnClearLog').addEventListener('click', () => {
  logEntries.innerHTML = '';
});

// Initial load
fetchStats();
setInterval(fetchStats, 3000);
