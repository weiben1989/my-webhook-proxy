// /api/webhook.ts  —— 适配多格式信号 + 纯数字标的必查并替换中文名 (纯 JavaScript 版本)
const fetch = require("node-fetch");
const { URL } = require("url");

const config = {
  api: { bodyParser: false },
};

// --- Webhook Configuration ---
/** @type {Record<string, {url: string, type?: 'raw'|'wecom'}>} */
let webhookMap = {};
try {
  if (process.env.WEBHOOK_CONFIG) webhookMap = JSON.parse(process.env.WEBHOOK_CONFIG);
} catch {
  webhookMap = {};
}

/* ================= 基础工具 ================= */
function getRawBody(req, maxSize = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (err) => reject(err));
  });
}

async function fetchWithTimeout(input, opts = {}) {
  const { timeout = 1500, ...rest } = opts;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(input, { ...rest, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(id);
  }
}

function stringifyAlertBody(raw) {
  try {
    const obj = JSON.parse(raw);
    return Object.entries(obj)
      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join("\n");
  } catch {
    return raw;
  }
}

/* ============== A/H 名称查询（纯数字必查） ============== */
const gbDecoder = new TextDecoder("gb18030");

function padHK(code) {
  return String(code).padStart(5, "0"); // 港股 5 位
}

async function getStockNameFromSina(stockCode, marketPrefix) {
  const finalCode = marketPrefix === "hk" ? padHK(stockCode) : stockCode;
  const url = `https://hq.sinajs.cn/list=${marketPrefix}${finalCode}`;
  try {
    const resp = await fetchWithTimeout(url, {
      timeout: 1500,
      headers: { "User-Agent": "Mozilla.5.0" },
    });
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    const text = gbDecoder.decode(buf);
    const name = text.split('"')[1]?.split(",")[0]?.trim();
    return name || null;
  } catch {
    return null;
  }
}

async function getStockNameFromTencent(stockCode, marketPrefix) {
  const finalCode = marketPrefix === "hk" ? padHK(stockCode) : stockCode;
  const url = `https://qt.gtimg.cn/q=${marketPrefix}${finalCode}`;
  try {
    const resp = await fetchWithTimeout(url, {
      timeout: 1500,
      headers: { "User-Agent": "Mozilla.5.0" },
    });
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    const text = gbDecoder.decode(buf);
    const parts = text.split("~");
    if (parts.length > 2) return parts[1]?.trim() || null;
    return null;
  } catch {
    return null;
  }
}

async function getChineseStockName(code) {
  let prefix = null;
  if (/^\d{1,5}$/.test(code)) {
    prefix = "hk";
  } else if (/^\d{6}$/.test(code)) {
    if /^[56]/.test(code)) prefix = "sh";
    else if /^[013]/.test(code)) prefix = "sz";
    else prefix = null;
  }
  if (!prefix) return null;

  let name = await getStockNameFromSina(code, prefix);
  if (!name) name = await getStockNameFromTencent(code, prefix);
  return name || null;
}

function replaceTargets(body) {
  return body.replace(/(标的\s*[:：]\s*)(\d{1,6})/g, (m, g1, code) => {
    if (!/^\d{1,6}$/.test(code)) return m;
    return `${g1}__LOOKUP__${code}__`;
  });
}

async function resolveTargets(text) {
  const codes = [...new Set((text.match(/__LOOKUP__(\d{1,6})__/g) || []).map(s => s.slice(10, -2)))];
  if (codes.length === 0) {
    return text;
  }

  const names = await Promise.all(codes.map(c => getChineseStockName(c)));
  const nameMap = Object.fromEntries(codes.map((code, i) => [code, names[i]]));

  return text.replace(/__LOOKUP__(\d{1,6})__/g, (match, code) => {
    const name = nameMap[code];
    return name ? `${name}(${code})` : code;
  });
}

/* ============== 信号解析与展示 ============== */
function detectDirection(s) {
  const t = (s || "").toLowerCase();
  if (/(空信号|做空|空单|卖信号|short|sell|调仓空|追击空)/i.test(t)) return "short";
  if (/(多信号|做多|多单|买信号|long|buy|调仓多|追击多)/i.test(t)) return "long";
  if (/止损/i.test(t)) return "stop";
  return "neutral";
}
function icon(d) {
  if (d === "short") return "🔴 空";
  if (d === "long") return "🟢 多";
  if (d === "stop") return "⚠️ 止损";
  return "🟦 中性";
}
function stripBullet(s) {
  return s.replace(/^[\-\u2022\*]\s+/, "").trim();
}

function splitAlertsGeneric(text) {
  const t = (text || "").trim();
  if (!t) return [];

  const lines0 = t.split("\n").map(s => s.trim()).filter(Boolean);
  const isKvCard =
    /^信号详情$/i.test(lines0[0] || "") ||
    (lines0.length >= 3 && /^[-\s]*标的\s*[:：]/.test(lines0[0]) && /^[-\s]*周期\s*[:：]/.test(lines0[1]));

  if (isKvCard) {
    const fields = [];
    for (const raw of lines0) {
      const line = stripBullet(raw);
      if (/^信号详情$/i.test(line)) continue;
      if (/^(标的|周期|价格|当前价格|信号|指标)\s*[:：]/.test(line)) fields.push(line);
    }
    return fields.length ? [fields.join(", ")] : [t];
  }

  const lines = t.split("\n").map(s => stripBullet(s)).filter(Boolean);
  const blocks = [];
  let buf = [];
  const flush = () => { if (buf.length) { blocks.push(buf.join(", ")); buf = []; } };

  for (const line of lines) {
    if (/^标的\s*[:：]/.test(line)) { flush(); buf.push(line); }
    else { if (buf.length === 0) continue; buf.push(line); }
  }
  flush();
  return blocks.length ? blocks : [stripBullet(t)];
}

function parseLine(line) {
  const raw = line.trim();

  const stock = raw.match(/标的\s*[:：]\s*([^\s,，!！]+)/)?.[1];
  const period = raw.match(/周期\s*[:：]\s*([0-9]+)/)?.[1];
  const price = raw.match(/(当前价格|价格)\s*[:：]\s*([0-9]+(?:\.[0-9]+)?)/)?.[2];
  const indicator = raw.match(/指标\s*[:：]\s*([^\s,，!！]+)/)?.[1];

  let signal = raw.match(/信号\s*[:：]\s*([^,，!！]+)/)?.[1];

  if (!signal) {
    let seg = raw;
    const idxPeriod = raw.search(/周期\s*[:：]/);
    if (idxPeriod >= 0) {
      const afterPeriod = raw.slice(idxPeriod);
      const commaIdx = afterPeriod.indexOf(",");
      seg = commaIdx >= 0 ? afterPeriod.slice(commaIdx + 1) : afterPeriod;
    }
    seg = seg
      .replace(/(当前价格|价格)\s*[:：].*$/, "")
      .replace(/指标\s*[:：].*$/, "")
      .replace(/^[，,\s\-]+/, "")
      .replace(/[，,!\s\-]+$/, "")
      .replace(/-?\s*标的\s*[:：].*$/i, "")
      .trim();
    if (seg) signal = seg;
  }

  const direction = detectDirection(signal);
  return { raw, stock, period, price, signal, indicator, direction };
}

function beautifyAlerts(content) {
  const chunks = splitAlertsGeneric(content);
  const parsed = chunks.map(parseLine);
  const valid = parsed.filter(p => !!p.stock && (!!p.signal || !!p.price));
  if (!valid.length) return content;

  return valid
    .map(p => {
      const parts = [];
      parts.push(`${icon(p.direction)}｜${p.stock}`);
      if (p.period) parts.push(`周期${p.period}`);
      if (p.price) parts.push(`价格 ${p.price}`);
      if (p.signal) parts.push(p.signal);
      if (p.indicator) parts.push(`指标 ${p.indicator}`);
      return `- ${parts[0]}${parts.length > 1 ? " · " + parts.slice(1).join(" · ") : ""}`;
    })
    .join("\n");
}

/* ================= 主 Handler ================= */
module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const url = new URL(req.url, `https://${req.headers.host}`);
    const key = url.searchParams.get("key");
    const cfg = key ? webhookMap[key] : undefined;
    if (!cfg?.url) return res.status(404).json({ error: "Key not found" });

    const rawBody = (await getRawBody(req)).toString("utf8");
    const messageBody = stringifyAlertBody(rawBody);

    const marked = replaceTargets(messageBody);
    const resolved = await resolveTargets(marked);

    const finalText = beautifyAlerts(resolved);

    const isWecom = cfg.type === "wecom";
    const resp = await fetchWithTimeout(cfg.url, {
      method: "POST",
      headers: isWecom
        ? { "Content-Type": "application/json" }
        : { "Content-Type": "text/plain; charset=utf-8" },
      body: isWecom
        ? JSON.stringify({ msgtype: "markdown", markdown: { content: finalText.replace(/\n/g, "\n\n") } })
        : finalText,
      timeout: 3000
    });

    if (!resp.ok) {
      const txt = await resp.text();
      return res.status(502).json({ error: `Forward failed: ${txt}` });
    }
    res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ 
        error: "Internal Server Error", 
        message: err.message,
        name: err.name
    });
  }
}

module.exports.config = config;

