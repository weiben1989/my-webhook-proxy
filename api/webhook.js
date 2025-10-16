import fetch from "node-fetch";
import { URL } from "url";

export const config = {
  api: { bodyParser: false },
};

let webhookMap = {};
try {
  if (process.env.WEBHOOK_CONFIG) webhookMap = JSON.parse(process.env.WEBHOOK_CONFIG);
} catch {
  webhookMap = {};
}

function getRawBody(req, maxSize = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", err => reject(err));
  });
}

async function fetchWithTimeout(input, opts = {}) {
  const { timeout = 1500, ...rest } = opts;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(input, { ...rest, signal: controller.signal });
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

/* ------------------- 股票中文名解析 ------------------- */
const gbDecoder = new TextDecoder("gb18030");

async function getStockName(stockCode, prefix) {
  const url = `https://hq.sinajs.cn/list=${prefix}${stockCode}`;
  try {
    const resp = await fetchWithTimeout(url, {
      timeout: 1500,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!resp.ok) return null;
    const buf = new Uint8Array(await resp.arrayBuffer());
    const text = gbDecoder.decode(buf);
    const name = text.split('"')[1]?.split(",")[0]?.trim();
    return name || null;
  } catch {
    return null;
  }
}

async function getChineseStockName(code) {
  let prefix = "";
  if (/^[56]/.test(code)) prefix = "sh";
  else if (/^[013]/.test(code)) prefix = "sz";
  else if (/^\d{1,5}$/.test(code)) prefix = "hk";
  if (!prefix) return null;
  return await getStockName(code, prefix);
}

function replaceTargets(body) {
  return body.replace(/(标的\s*[:：]\s*)(\d{1,6})/g, (m, g1, code) => {
    if (!/^\d{5,6}$/.test(code)) return m;
    return `${g1}__LOOKUP__${code}__`;
  });
}

async function resolveTargets(text) {
  const codes = [...new Set((text.match(/__LOOKUP__(\d{5,6})__/g) || []).map(s => s.slice(10, -2)))];
  for (const c of codes) {
    const name = await getChineseStockName(c);
    if (name) text = text.replace(new RegExp(`__LOOKUP__${c}__`, "g"), `${name}(${c})`);
  }
  return text;
}

/* ------------------- 信号解析 ------------------- */
function detectDirection(s) {
  s = (s || "").toLowerCase();
  if (/(空信号|做空|空单|卖信号|short|sell)/i.test(s)) return "short";
  if (/(多信号|做多|多单|买信号|long|buy)/i.test(s)) return "long";
  if (/止损/i.test(s)) return "stop";
  return "neutral";
}
function icon(d) {
  if (d === "short") return "🔴 空";
  if (d === "long") return "🟢 多";
  if (d === "stop") return "⚠️ 止损";
  return "🟦 中性";
}

function splitAlertsGeneric(text) {
  const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
  const blocks = [];
  let buf = [];
  const flush = () => { if (buf.length) { blocks.push(buf.join(", ")); buf = []; } };
  for (const line of lines) {
    if (/^标的\s*[:：]/.test(line)) { flush(); buf.push(line); }
    else if (/^(周期|价格|当前价格|信号|指标)\s*[:：]/.test(line)) buf.push(line);
    else { flush(); blocks.push(line); }
  }
  flush();
  return blocks.length ? blocks : [text];
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
    seg = seg.replace(/(当前价格|价格)\s*[:：].*$/, "")
             .replace(/指标\s*[:：].*$/, "")
             .trim()
             .replace(/^[，,\s]+/, "")
             .replace(/[，,!\s]+$/, "")
             .trim();
    if (seg) signal = seg;
  }

  const direction = detectDirection(signal || "");
  return { raw, stock, period, price, signal, indicator, direction };
}

function beautifyAlerts(content) {
  const chunks = splitAlertsGeneric(content);
  const parsed = chunks.map(parseLine);
  const valid = parsed.filter(p => (p.stock && (p.signal || p.price)) || (p.signal && p.price));

  if (!valid.length) return content;
  return valid
    .map(p => {
      const dir = icon(p.direction);
      const prd = p.period ? ` · 周期${p.period}` : "";
      const px = p.price ? ` · 价格 ${p.price}` : "";
      const sig = p.signal ? ` · ${p.signal}` : "";
      const ind = p.indicator ? ` · 指标 ${p.indicator}` : "";
      return `- ${dir}｜${p.stock}${prd}${px}${sig}${ind}`;
    })
    .join("\n");
}

/* ------------------- 主 Handler ------------------- */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const key = new URL(req.url, `https://${req.headers.host}`).searchParams.get("key");
    const cfg = webhookMap[key];
    if (!cfg?.url) return res.status(404).json({ error: "Key not found" });

    const rawBody = (await getRawBody(req)).toString("utf8");
    const msg = stringifyAlertBody(rawBody);
    const marked = replaceTargets(msg);
    const resolved = await resolveTargets(marked);
    const finalText = beautifyAlerts(resolved);

    const payload =
      cfg.type === "wecom"
        ? { msgtype: "markdown", markdown: { content: finalText.replace(/\n/g, "\n\n") } }
        : finalText;

    const resp = await fetch(cfg.url, {
      method: "POST",
      headers:
        cfg.type === "wecom"
          ? { "Content-Type": "application/json" }
          : { "Content-Type": "text/plain; charset=utf-8" },
      body: cfg.type === "wecom" ? JSON.stringify(payload) : finalText,
    });

    if (!resp.ok) {
      const txt = await resp.text();
      return res.status(502).json({ error: `Forward failed: ${txt}` });
    }
    res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
