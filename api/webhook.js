import fetch from "node-fetch";
import { URL } from "url";

export const config = {
  api: { bodyParser: false },
};

// --- Webhook Configuration ---
let webhookMap = {};
try {
  if (process.env.WEBHOOK_CONFIG) {
    webhookMap = JSON.parse(process.env.WEBHOOK_CONFIG);
  }
} catch (error) {
  console.error("Config parse error:", error);
  webhookMap = {};
}

/* ================================
   工具函数
   ================================ */
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
    return await fetch(input, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function isSafeUrl(u) {
  try {
    const url = new URL(u);
    if (!/^https?:$/.test(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host))
      return false;
    return true;
  } catch {
    return false;
  }
}

function stringifyAlertBody(raw) {
  try {
    const obj = JSON.parse(raw);
    return Object.entries(obj)
      .map(
        ([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`
      )
      .join("\n");
  } catch {
    return raw;
  }
}

/* ================================
   A股/港股中文名查询（仅数字代码）
   ================================ */
function padHK(code) {
  return String(code).padStart(5, "0");
}
const gbDecoder = new TextDecoder("gb18030");

async function getStockNameFromSina(stockCode, marketPrefix) {
  let finalCode = stockCode;
  if (marketPrefix === "hk") finalCode = padHK(stockCode);
  const url = `https://hq.sinajs.cn/list=${marketPrefix}${finalCode}`;
  try {
    const resp = await fetchWithTimeout(url, {
      timeout: 1500,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!resp.ok) return null;
    const buf = new Uint8Array(await resp.arrayBuffer());
    const text = gbDecoder.decode(buf);
    const parts = text.split('"');
    if (parts.length > 1 && parts[1]) {
      const name = parts[1].split(",")[0]?.trim();
      return name || null;
    }
    return null;
  } catch {
    return null;
  }
}

async function getStockNameFromTencent(stockCode, marketPrefix) {
  let finalCode = stockCode;
  if (marketPrefix === "hk") finalCode = padHK(stockCode);
  const url = `https://qt.gtimg.cn/q=${marketPrefix}${finalCode}`;
  try {
    const resp = await fetchWithTimeout(url, {
      timeout: 1500,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!resp.ok) return null;
    const buf = new Uint8Array(await resp.arrayBuffer());
    const text = gbDecoder.decode(buf);
    const parts = text.split("~");
    if (parts.length > 2) {
      const name = parts[1]?.trim();
      return name || null;
    }
    return null;
  } catch {
    return null;
  }
}

const NAME_CACHE = new Map();
function cacheGet(key) {
  const v = NAME_CACHE.get(key);
  if (v && NAME_CACHE.size > 5000) {
    let i = 0;
    for (const k of NAME_CACHE.keys()) {
      NAME_CACHE.delete(k);
      if (++i > 2500) break;
    }
  }
  return v || null;
}
function cacheSet(key, val) {
  NAME_CACHE.set(key, val);
}

async function getChineseStockName(stockCode) {
  // 仅数字代码：A/H
  let prefix = null;
  if (/^\d{1,5}$/.test(stockCode)) {
    prefix = "hk"; // 1~5位：港股
  } else if (/^\d{6}$/.test(stockCode)) {
    if (/^[56]/.test(stockCode)) prefix = "sh";
    else if (/^[013]/.test(stockCode)) prefix = "sz";
  }
  if (!prefix) return null;

  const cacheKey = `${prefix}:${stockCode}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let name = await getStockNameFromSina(stockCode, prefix);
  if (!name) name = await getStockNameFromTencent(stockCode, prefix);
  if (name) cacheSet(cacheKey, name);
  return name || null;
}

// 将“标的: 数字代码”替换为“标的:中文名(代码)”；非数字（如 GER40）不处理
function replaceTargets(body) {
  return body.replace(/(标的\s*[:：]\s*)(\d{1,6})/g, (m, g1, code) => {
    if (!/^\d{5,6}$/.test(code)) return m; // 只处理 5~6 位
    return `${g1}__LOOKUP__${code}__`;
  });
}
async function resolveTargets(transformed) {
  const codes =
    Array.from(
      new Set(
        (transformed.match(/__LOOKUP__(\d{5,6})__/g) || []).map((s) =>
          s.slice(10, -2)
        )
      )
    ) || [];
  const map = new Map();
  await Promise.all(
    codes.map(async (c) => {
      const name = await getChineseStockName(c);
      if (name) map.set(c, `${name}(${c})`);
    })
  );
  let out = transformed;
  for (const c of codes) {
    const rep = map.get(c);
    out = out.replace(new RegExp(`__LOOKUP__${c}__`, "g"), rep ?? c);
  }
  return out;
}

/* ================================
   展示层：信号解析 + 美化输出（兼容无“✅”、多行 KV、粘连）
   ================================ */
function detectDirection(signalText) {
  const s = (signalText || "").toLowerCase();
  if (/(卖信号|做空|空单|空头|调仓空|追击空|空信号|short|sell)/i.test(s)) return "short";
  if (/(买信号|做多|多单|多头|调仓多|追击多|多信号|long|buy)/i.test(s)) return "long";
  if (/止损/i.test(s)) return "stop";
  return "neutral";
}

// 把输入拆成“一条一条”的记录：支持有/无“✅”、多行 KV、无换行粘连
function splitAlertsGeneric(text) {
  const t = (text || "").trim();
  if (!t) return [];

  // 标准化 ✅
  let normalized = t.replace(/✅\s*/g, "\n✅ ").replace(/^\n+/, "");

  // 按行切分，合并以“标的:”开头的块及其后续 KV（周期/价格/当前价格/信号/指标）
  const lines = normalized
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const blocks = [];
  let buf = [];

  const flush = () => {
    if (buf.length) {
      blocks.push(buf.join(", ")); // 合并为一行，便于通用解析
      buf = [];
    }
  };

  for (const line of lines) {
    const lineNoTick = line.replace(/^✅\s*/, "");
    if (/^标的\s*[:：]/.test(lineNoTick)) {
      flush();
      buf.push(lineNoTick);
    } else if (/^(周期|价格|当前价格|信号|指标)\s*[:：]/.test(lineNoTick)) {
      buf.push(lineNoTick);
    } else {
      flush();
      blocks.push(lineNoTick);
    }
  }
  flush();

  if (blocks.length === 0) return [t];
  return blocks;
}

function parseLine(line) {
  const raw = line.trim();
  const stock = raw.match(/标的\s*[:：]\s*([^\s,，!！]+)/)?.[1];
  const period = raw.match(/周期\s*[:：]\s*([0-9]+)/)?.[1];
  const price = raw.match(/(当前价格|价格)\s*[:：]\s*([0-9]+(?:\.[0-9]+)?)/)?.[2];
  const indicator = raw.match(/指标\s*[:：]\s*([^\s,，!！]+)/)?.[1];

  // 信号片段：位于“周期: …,” 与 “价格/当前价格/指标” 之前
  let signal = raw;
  const idxPeriod = raw.search(/周期\s*[:：]/);
  if (idxPeriod >= 0) {
    const afterPeriod = raw.slice(idxPeriod);
    const commaIdx = afterPeriod.indexOf(",");
    signal = commaIdx >= 0 ? afterPeriod.slice(commaIdx + 1) : afterPeriod;
  }
  signal = signal
    .replace(/(当前价格|价格)\s*[:：].*$/, "")
    .replace(/指标\s*[:：].*$/, "")
    .replace(/[!！]\s*$/, "")
    .replace(/[，,]\s*$/, "")
    .replace(/^\s*[，,]\s*/, "")
    .trim();

  const direction = detectDirection(signal);
  return { raw, stock, period, price, signal, indicator, direction };
}

function iconOf(direction) {
  switch (direction) {
    case "long":
      return "🟢 多";
    case "short":
      return "🔴 空";
    case "stop":
      return "⚠️ 止损";
    default:
      return "🟦 中性";
  }
}

function dedupeAdjacent(lines) {
  const out = [];
  let prevKey = "";
  for (const it of lines) {
    const key = `${it.stock}|${it.direction}|${it.signal}`;
    if (key !== prevKey) out.push(it);
    prevKey = key;
  }
  return out;
}

function sortLines(a, b) {
  const rank = (d) => (d === "short" ? 0 : d === "stop" ? 1 : d === "long" ? 2 : 3);
  const r = rank(a.direction) - rank(b.direction);
  if (r !== 0) return r;
  return (a.stock || "").localeCompare(b.stock || "", "zh-Hans-CN");
}

function beautifyAlerts(processedContent) {
  const chunks = splitAlertsGeneric(processedContent);
  const parsed = chunks.map(parseLine);

  const valid = parsed.filter((p) => {
    const cnt =
      (p.stock ? 1 : 0) +
      (p.price ? 1 : 0) +
      (p.signal ? 1 : 0) +
      (p.period ? 1 : 0) +
      (p.indicator ? 1 : 0);
    return cnt >= 2;
  });

  const cleaned = dedupeAdjacent(valid).sort(sortLines);

  const stats = cleaned.reduce(
    (acc, cur) => {
      acc.total++;
      acc[cur.direction] = (acc[cur.direction] || 0) + 1;
      return acc;
    },
    { total: 0, long: 0, short: 0, stop: 0, neutral: 0 }
  );

  if (cleaned.length === 0) {
    // 解析失败，回退原文
    return processedContent;
  }

  const header = `**盘中信号速览**  |  合计 ${stats.total}  ·  🟢 多 ${stats.long}  ·  🔴 空 ${stats.short}  ·  ⚠️ 止损 ${stats.stop}`;

  const lines = cleaned.map((it) => {
    const dir = iconOf(it.direction);
    const name = it.stock ?? "（未知标的）";
    const prd = it.period ? ` · 周期${it.period}` : "";
    const px = it.price ? ` · 价格 ${it.price}` : "";
    const sig = it.signal ? ` · ${it.signal}` : "";
    const ind = it.indicator ? ` · 指标 ${it.indicator}` : "";
    return `- ${dir}｜**${name}**${prd}${px}${sig}${ind}`;
  });

  return `${header}\n\n${lines.join("\n")}`;
}

/* ================================
   主处理：Next.js API Route (req, res)
   ================================ */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    // 读取查询参数中的 key
    const requestUrl = new URL(req.url, `https://${req.headers.host}`);
    const proxyKey = requestUrl.searchParams.get("key");

    if (!proxyKey) {
      return res.status(400).json({ error: "Missing key" });
    }

    const proxyConfig = webhookMap[proxyKey];
    if (!proxyConfig || !proxyConfig.url) {
      return res.status(404).json({ error: "Key not found" });
    }

    if (!isSafeUrl(proxyConfig.url)) {
      return res.status(400).json({ error: "Unsafe target url" });
    }

    const finalWebhookUrl = proxyConfig.url;
    const destinationType = proxyConfig.type || "raw";

    // 原始 body（限制 1MB）
    const rawBody = (await getRawBody(req)).toString("utf8");

    // JSON 扁平化或原文
    const messageBody = stringifyAlertBody(rawBody).trim();

    // 名称替换（仅数字代码）
    const marked = replaceTargets(messageBody);
    const processedContent = await resolveTargets(marked);

    // 展示层美化（识别多/空/止损 + 统计 + Markdown）
    const finalMessage = beautifyAlerts(processedContent);

    // 转发
    let forwardResponse;
    if (destinationType === "wecom") {
      const payload = {
        msgtype: "markdown",
        markdown: { content: finalMessage.replace(/\n/g, "\n\n") }, // WeCom 对双换行更友好
      };
      forwardResponse = await fetchWithTimeout(finalWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        timeout: 2500,
      });
    } else {
      forwardResponse = await fetchWithTimeout(finalWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: finalMessage,
        timeout: 2500,
      });
    }

    if (!forwardResponse.ok) {
      const responseText = await forwardResponse.text();
      console.error(`Forward failed: ${forwardResponse.status} - ${responseText}`);
      return res.status(502).json({ error: "Forward failed" });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ error: error.message || "Internal Error" });
  }
}
