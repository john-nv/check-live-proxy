const express = require("express");
const axios = require("axios");
const { SocksProxyAgent } = require("socks-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");

const app = express();

app.use(express.json({ limit: "5mb" }));

const CONFIG = {
  PORT: 3000,
  CONCURRENCY: 50,
  TIMEOUT_MS: 7000,
  RETRY: 1,
  TEST_URL: "https://api.ipify.org?format=json",
};

function normalizeProxy(proxy) {
  return String(proxy || "").trim();
}

function isValidProxy(proxy) {
  return /^(socks4|socks5|http|https):\/\/[^@\s]+:[^@\s]+@[\w.-]+:\d+$/i.test(proxy);
}

function createAgent(proxyUrl) {
  if (proxyUrl.startsWith("socks5://") || proxyUrl.startsWith("socks4://")) {
    return new SocksProxyAgent(proxyUrl);
  }

  if (proxyUrl.startsWith("http://") || proxyUrl.startsWith("https://")) {
    return new HttpsProxyAgent(proxyUrl);
  }

  throw new Error("INVALID_PROTOCOL");
}

function normalizeError(err) {
  const msg = err?.message || "UNKNOWN_ERROR";

  if (msg.includes("timeout")) return "TIMEOUT";
  if (msg.includes("ECONNREFUSED")) return "CONNECTION_REFUSED";
  if (msg.includes("ECONNRESET")) return "CONNECTION_RESET";
  if (msg.includes("ETIMEDOUT")) return "TIMEOUT";
  if (msg.includes("ENOTFOUND")) return "DNS_ERROR";
  if (msg.includes("407")) return "AUTH_FAILED";
  if (msg.includes("Invalid proxy")) return "INVALID_PROXY";

  return msg;
}

async function checkProxyOnce(proxy) {
  const agent = createAgent(proxy);
  const start = Date.now();

  const response = await axios.get(CONFIG.TEST_URL, {
    httpAgent: agent,
    httpsAgent: agent,
    timeout: CONFIG.TIMEOUT_MS,
    validateStatus: status => status >= 200 && status < 300,
  });

  return {
    proxy,
    status: "LIVE",
    live: true,
    ip: response.data?.ip || "-",
    ping: Date.now() - start,
    error: null,
  };
}

async function checkProxy(proxy) {
  const cleanProxy = normalizeProxy(proxy);

  if (!isValidProxy(cleanProxy)) {
    return {
      proxy: cleanProxy,
      status: "INVALID_FORMAT",
      live: false,
      ip: "-",
      ping: null,
      error: "Proxy phải đúng dạng socks5://user:pass@ip:port",
    };
  }

  let lastError = null;

  for (let attempt = 0; attempt <= CONFIG.RETRY; attempt++) {
    try {
      return await checkProxyOnce(cleanProxy);
    } catch (err) {
      lastError = err;
    }
  }

  return {
    proxy: cleanProxy,
    status: normalizeError(lastError),
    live: false,
    ip: "-",
    ping: null,
    error: normalizeError(lastError),
  };
}

async function runQueue(items, concurrency, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function runner() {
    while (index < items.length) {
      const currentIndex = index++;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => runner()
    )
  );

  return results;
}

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8" />
<title>Senior Proxy Checker</title>

<style>
body {
  background: #0f1115;
  color: #ffffff;
  font-family: Arial, sans-serif;
  padding: 30px;
}

textarea {
  width: 100%;
  height: 260px;
  background: #1b1f27;
  color: #00ff99;
  border: 1px solid #333;
  padding: 15px;
  font-size: 14px;
  border-radius: 10px;
  outline: none;
}

button {
  margin-top: 15px;
  padding: 12px 20px;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  background: #00cc88;
  color: #fff;
  font-weight: bold;
}

button:disabled {
  background: #555;
  cursor: not-allowed;
}

.summary {
  margin-top: 20px;
  display: flex;
  gap: 15px;
  flex-wrap: wrap;
}

.card {
  background: #1b1f27;
  padding: 12px 18px;
  border-radius: 10px;
  border: 1px solid #333;
}

table {
  width: 100%;
  margin-top: 20px;
  border-collapse: collapse;
  font-size: 14px;
}

th, td {
  border: 1px solid #333;
  padding: 10px;
  text-align: left;
}

th {
  background: #1b1f27;
}

.live {
  color: #00ff99;
  font-weight: bold;
}

.die {
  color: #ff4d4d;
  font-weight: bold;
}

.invalid {
  color: #ffaa00;
  font-weight: bold;
}
</style>
</head>

<body>

<h2>SOCKS5 / HTTP Proxy Checker</h2>

<textarea id="proxyList" placeholder="Mỗi dòng 1 proxy:
socks5://user:pass@ip:port
http://user:pass@ip:port"></textarea>

<br />

<button id="checkBtn" onclick="startCheck()">CHECK PROXY</button>

<div id="summary" class="summary"></div>

<table>
  <thead>
    <tr>
      <th>#</th>
      <th>Status</th>
      <th>Proxy</th>
      <th>IP</th>
      <th>Ping</th>
      <th>Error</th>
    </tr>
  </thead>
  <tbody id="result"></tbody>
</table>

<script>
async function startCheck() {
  const button = document.getElementById("checkBtn");
  const raw = document.getElementById("proxyList").value;

  const proxies = raw
    .split(/\\n+/)
    .map(v => v.trim())
    .filter(Boolean);

  if (!proxies.length) {
    alert("Nhập proxy trước");
    return;
  }

  button.disabled = true;
  button.innerText = "ĐANG CHECK...";

  document.getElementById("result").innerHTML = "";
  document.getElementById("summary").innerHTML = '<div class="card">Đang kiểm tra...</div>';

  try {
    const res = await fetch("/check", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ proxies })
    });

    const payload = await res.json();

    let html = "";
    let live = 0;
    let die = 0;
    let invalid = 0;

    payload.results.forEach((item, index) => {
      if (item.live) live++;
      else if (item.status === "INVALID_FORMAT") invalid++;
      else die++;

      const statusClass = item.live
        ? "live"
        : item.status === "INVALID_FORMAT"
          ? "invalid"
          : "die";

      html += \`
        <tr>
          <td>\${index + 1}</td>
          <td class="\${statusClass}">\${item.status}</td>
          <td>\${item.proxy}</td>
          <td>\${item.ip || "-"}</td>
          <td>\${item.ping ? item.ping + " ms" : "-"}</td>
          <td>\${item.error || "-"}</td>
        </tr>
      \`;
    });

    document.getElementById("result").innerHTML = html;

    document.getElementById("summary").innerHTML = \`
      <div class="card">TOTAL: \${payload.total}</div>
      <div class="card live">LIVE: \${live}</div>
      <div class="card die">DIE: \${die}</div>
      <div class="card invalid">INVALID: \${invalid}</div>
      <div class="card">DUPLICATE REMOVED: \${payload.duplicateRemoved}</div>
      <div class="card">TIME: \${payload.elapsedMs} ms</div>
    \`;
  } catch (err) {
    document.getElementById("summary").innerHTML =
      '<div class="card die">ERROR: ' + err.message + '</div>';
  } finally {
    button.disabled = false;
    button.innerText = "CHECK PROXY";
  }
}
</script>

</body>
</html>
  `);
});

app.post("/check", async (req, res) => {
  const startedAt = Date.now();

  const input = Array.isArray(req.body.proxies) ? req.body.proxies : [];

  const normalized = input
    .map(normalizeProxy)
    .filter(Boolean);

  const uniqueProxies = [...new Set(normalized)];

  const results = await runQueue(
    uniqueProxies,
    CONFIG.CONCURRENCY,
    checkProxy
  );

  res.json({
    total: uniqueProxies.length,
    originalTotal: normalized.length,
    duplicateRemoved: normalized.length - uniqueProxies.length,
    concurrency: CONFIG.CONCURRENCY,
    timeoutMs: CONFIG.TIMEOUT_MS,
    retry: CONFIG.RETRY,
    elapsedMs: Date.now() - startedAt,
    results,
  });
});

app.listen(process.env.PORT || CONFIG.PORT, () => {
  console.log("Running: http://localhost:" + (process.env.PORT || CONFIG.PORT));
});