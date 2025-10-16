// /api/webhook-proxy.ts  —— 适配多格式信号 + 纯数字标的必查并替换中文名
import fetch from "node-fetch";
import { URL } from "url";

export const config = {
  api: { bodyParser: false },
};

// --- Webhook Configuration ---
let webhookMap: Record<string, { url: string; type?: "raw" | "wecom" }> = {};
try {
  if (process.env.WEBHOOK_CONFIG) webhookMap = JSON.parse(process.env.WEBHOOK_CONFIG);
} catch {
  webhookMap = {};
}

/* ================= 基础工具 ================= */
function getRawBody(req: any, maxSize = 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (err: Error) => reject(err));
  });
}

async function fetchWithTimeout(input: RequestInfo, opts: RequestInit & { timeout?: number } = {}) {
  const { timeout = 1500, ...rest } = opts;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(input, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function stringifyAlertBody(raw: string) {
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
// Node18 的 TextDecoder 支持 GB18030，兼容 GBK 内容
const gbDecoder = new TextDecoder("gb18030");

function padHK(code: string) {
  return String(code).padStart(5, "0"); // 港股 5 位
}

async function getStockNameFromSina(stockCode: string, marketPrefix: "hk" | "sh" | "sz") {
  const finalCode = marketPrefix === "hk" ? padHK(stockCode) : stockCode;
  const url = `https://hq.sinajs.cn/list=${marketPrefix}${finalCode}`;
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

async function getStockNameFromTencent(stockCode: string, marketPrefix: "hk" | "sh" | "sz") {
  const finalCode = marketPrefix === "hk" ? padHK(stockCode) : stockCode;
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
    if (parts.length > 2) return parts[1]?.trim() || null;
    return null;
  } catch {
    return null;
  }
}

async function getChineseStockName(code: string) {
  // 这里严格把“纯数字标的”都做查询：
  // - 长度 1~5 位：按港股处理（hk）
  // - 长度 6 位：按 A 股处理（sh/sz）
  let prefix: "hk" | "sh" | "sz" | null = null;
  if (/^\d{1,5}$/.test(code)) {
    prefix = "hk";
  } else if (/^\d{6}$/.test(code)) {
    if (/^[56]/.test(code)) prefix = "sh";
    else if (/^[013]/.test(code)) prefix = "sz";
    else prefix = null;
  }
  if (!prefix) return null;

  // 先新浪再腾讯
  let name = await getStockNameFromSina(code, prefix);
  if (!name) name = await getStockNameFromTencent(code, prefix);
  return name || null;
}

// 仅在“标的:”后面是**纯数字(1~6位)**时打标进行查询替换
function replaceTargets(body: string) {
  return body.replace(/(标的\s*[:：]\s*)(\d{1,6})/g, (m, g1, code) => {
    if (!/^\d{1,6}$/.test(code)) return m;
    return `${g1}__LOOKUP__${code}__`;
  });
}

async function resolveTargets(text: string) {
  const codes = [...new Set((text.match(/__LOOKUP__(\d{1,6})__/g) || []).map(s => s.slice(10, -2)))];
  for (const c of codes) {
    const name = await getChineseStockName(c);
    if (name) {
      text = text.replace(new RegExp(`__LOOKUP__${c}__`, "g"), `${name}(${c})`);
    } else {
      // 查询不到就还原成数字代码本身
      text = text.replace(new RegExp(`__LOOKUP__${c}__`, "g"), c);
    }
  }
  return text;
}

/* ============== 信号解析与展示 ============== */
function detectDirection(s?: string) {
  const t = (s || "").toLowerCase();
  if (/(空信号|做空|空单|卖信号|short|sell|调仓空|追击空)/i.test(t)) return "short";
  if (/(多信号|做多|多单|买信号|long|buy|调仓多|追击多)/i.test(t)) return "long";
  if (/止损/i.test(t)) return "stop";
  return "neutral";
}
function icon(d: string) {
  if (d === "short") return "🔴 空";
  if (d === "long") return "🟢 多";
  if (d === "stop") return "⚠️ 止损";
  return "🟦 中性";
}
function stripBullet(s: string) {
  return s.replace(/^[\-\u2022\*]\s+/, "").trim(); // 去掉 - / • / *
}

// 专门兼容“信号详情 + 多行 KV 卡片”，否则走通用块切分
function splitAlertsGeneric(text: string) {
  const t = (text || "").trim();
  if (!t) return [];

  const lines0 = t.split("\n").map(s => s.trim()).filter(Boolean);
  const isKvCard =
    /^信号详情$/i.test(lines0[0] || "") ||
    (lines0.length >= 3 && /^[-\s]*标的\s*[:：]/.test(lines0[0]) && /^[-\s]*周期\s*[:：]/.test(lines0[1]));

  if (isKvCard) {
    const fields: string[] = [];
    for (const raw of lines0) {
      const line = stripBullet(raw);
      if (/^信号详情$/i.test(line)) continue;
      if (/^(标的|周期|价格|当前价格|信号|指标)\s*[:：]/.test(line)) fields.push(line);
    }
    return fields.length ? [fields.join(", ")] : [t];
  }

  // 常规路径：以“标的:”为起点，直到下一个“标的:”为止
  const lines = t.split("\n").map(s => stripBullet(s)).filter(Boolean);
  const blocks: string[] = [];
  let buf: string[] = [];
  const flush = () => { if (buf.length) { blocks.push(buf.join(", ")); buf = []; } };

  for (const line of lines) {
    if (/^标的\s*[:：]/.test(line)) { flush(); buf.push(line); }
    else { if (buf.length === 0) continue; buf.push(line); } // 丢弃没有标的的“孤儿行”
  }
  flush();
  return blocks.length ? blocks : [stripBullet(t)];
}

function parseLine(line: string) {
  const raw = line.trim();

  // 基础字段
  const stock = raw.match(/标的\s*[:：]\s*([^\s,，!！]+)/)?.[1];
  const period = raw.match(/周期\s*[:：]\s*([0-9]+)/)?.[1];
  const price = raw.match(/(当前价格|价格)\s*[:：]\s*([0-9]+(?:\.[0-9]+)?)/)?.[2];
  const indicator = raw.match(/指标\s*[:：]\s*([^\s,，!！]+)/)?.[1];

  // 优先：显式“信号: xxx”
  let signal = raw.match(/信号\s*[:：]\s*([^,，!！]+)/)?.[1];

  // 兜底：从“周期:”之后到“价格/指标”之前的自由文本
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

// 只输出干净列表（无标题/统计），严格要求：有“标的”且（有“信号”或“价格”）
function beautifyAlerts(content: string) {
  const chunks = splitAlertsGeneric(content);
  const parsed = chunks.map(parseLine);
  const valid = parsed.filter(p => !!p.stock && (!!p.signal || !!p.price));
  if (!valid.length) return content;

  return valid
    .map(p => {
      const parts: string[] = [];
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
export default async function handler(req: any, res: any) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const url = new URL(req.url, `https://${req.headers.host}`);
    const key = url.searchParams.get("key");
    const cfg = key ? webhookMap[key] : undefined;
    if (!cfg?.url) return res.status(404).json({ error: "Key not found" });

    // 读取原始 body
    const rawBody = (await getRawBody(req)).toString("utf8");
    const messageBody = stringifyAlertBody(rawBody);

    // ——① 标的名替换（纯数字 1~6 位必查并转中文名(代码)）——
    const marked = replaceTargets(messageBody);
    const resolved = await resolveTargets(marked);

    // ——② 展示层美化（无标题，纯列表）——
    const finalText = beautifyAlerts(resolved);

    // ——③ 转发——
    const isWecom = cfg.type === "wecom";
    const resp = await fetch(cfg.url, {
      method: "POST",
      headers: isWecom
        ? { "Content-Type": "application/json" }
        : { "Content-Type": "text/plain; charset=utf-8" },
      body: isWecom
        ? JSON.stringify({ msgtype: "markdown", markdown: { content: finalText.replace(/\n/g, "\n\n") } })
        : finalText,
    });

    if (!resp.ok) {
      const txt = await resp.text();
      return res.status(502).json({ error: `Forward failed: ${txt}` });
    }
    res.status(200).json({ success: true });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message || "Internal Error" });
  }
}
