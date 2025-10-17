const fetch = require('node-fetch');
const { AbortController } = require('abort-controller');

// Vercel 平台配置
module.exports.config = {
  api: {
    bodyParser: false, // 禁用 Vercel 的默认解析器，我们自己处理原始请求体
  },
};

// --- Webhook 配置 ---
// 移除了 TypeScript 的 interface 定义
let webhookMap = {};
try {
  if (process.env.WEBHOOK_CONFIG) {
    webhookMap = JSON.parse(process.env.WEBHOOK_CONFIG);
  }
} catch (error) {
  console.error("解析环境变量 WEBHOOK_CONFIG 失败:", error);
}

// --- 静态品种映射表 (高效) ---
const SYMBOL_MAP = {
  // 期货
  'CL1!': '轻质原油期货', 'GC1!': '黄金期货', 'SI1!': '白银期货',
  'HG1!': '铜期货', 'NG1!': '天然气期货', 'RB1!': '螺纹钢期货',
  'IODEX': '铁矿石期货',
  // 外汇
  'DXY': '美元指数', 'XAUUSD': '黄金现货/美元', 'XAGUSD': '白银/美元',
  'EURUSD': '欧元/美元', 'GBPUSD': '英镑/美元', 'USDJPY': '美元/日元',
  'AUDUSD': '澳元/美元',
  // 加密货币
  'BTCUSDT': '比特币/USDT', 'BTCUSD': '比特币/美元',
  'ETHUSDT': '以太坊/USDT', 'ETHUSD': '以太坊/美元',
  // 美股指数/债券
  'US10Y': '美国10年期国债收益率', 'US02Y': '美国2年期国债收益率',
  'SPX': '标普500指数', 'NDX': '纳斯达克100指数',
};

// --- 工具函数 ---
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

async function fetchWithTimeout(url, options = {}) {
  const { timeout = 2000, ...rest } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...rest, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(id);
  }
}

// --- 股票名称查询模块 (动态) ---
const gbDecoder = new TextDecoder('gb18030');

async function getStockNameFromSina(stockCode, marketPrefix) {
  const url = `https://hq.sinajs.cn/list=${marketPrefix}${stockCode}`;
  try {
    const resp = await fetchWithTimeout(url);
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    const text = gbDecoder.decode(buf);
    const name = text.split('"')[1]?.split(',')[0]?.trim();
    return name || null;
  } catch {
    return null;
  }
}

async function getStockNameFromTencent(stockCode, marketPrefix) {
  const finalCode = marketPrefix === 'hk' ? stockCode.padStart(5, '0') : stockCode;
  const url = `https://qt.gtimg.cn/q=${marketPrefix}${finalCode}`;
  try {
    const resp = await fetchWithTimeout(url);
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    const text = gbDecoder.decode(buf);
    const parts = text.split('~');
    return parts.length > 1 ? parts[1]?.trim() || null : null;
  } catch {
    return null;
  }
}

async function getChineseStockName(stockCode) {
  let marketPrefix = null;
  if (/^\d{1,5}$/.test(stockCode)) marketPrefix = 'hk';
  else if (/^\d{6}$/.test(stockCode)) {
    if (stockCode.startsWith('6') || stockCode.startsWith('5')) marketPrefix = 'sh';
    else if (stockCode.startsWith('0') || stockCode.startsWith('3') || stockCode.startsWith('1')) marketPrefix = 'sz';
  }
  if (!marketPrefix) return null;

  const name = await getStockNameFromSina(stockCode, marketPrefix) ?? await getStockNameFromTencent(stockCode, marketPrefix);
  return name;
}

// --- 新增：信号方向识别 ---
function getSignalPrefix(message) {
  if (/(多|buy|long|看涨|做多|多头)/i.test(message)) {
    return '🟢 ';
  }
  if (/(空|sell|short|看跌|做空|空头)/i.test(message)) {
    return '🔴 ';
  }
  return ''; // 如果没有明确的多空信号，则不添加任何图标
}

// --- 核心消息处理逻辑 ---
async function processMessage(body) {
  const match = body.match(/标的\s*[:：]\s*([A-Za-z0-9!_.-]+)/);
  if (!match) {
    return body; // 未匹配到 "标的"，返回原文
  }

  const originalPattern = match[0]; // "标的: CL1!"
  const symbol = match[1]; // "CL1!"

  // 1. 优先从静态映射表查找
  let name = SYMBOL_MAP[symbol];

  // 2. 如果是纯数字且表中没有，则尝试查询股票API
  if (!name && /^\d{1,6}$/.test(symbol)) {
    name = await getChineseStockName(symbol);
  }

  // 3. 如果找到了名称，则替换原文
  if (name) {
    return body.replace(originalPattern, `标的: **${name}(${symbol})**`);
  }

  return body; // 未找到任何名称，返回原文
}

// --- 主处理函数 ---
module.exports = async function handler(req, res) {
  const debugLog = [];
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const key = req.query.key;
    const config = key ? webhookMap[key] : undefined;
    if (!config?.url) {
      return res.status(404).json({ error: `Key '${key}' not found in configuration.` });
    }

    const rawBody = (await getRawBody(req)).toString('utf8');
    let messageBody = rawBody;
    try {
      // 尝试解析JSON，如果失败则使用原始文本
      const data = JSON.parse(rawBody);
      messageBody = Object.entries(data).map(([k, v]) => `${k}: ${v}`).join(', ');
    } catch {
      // Not a JSON, proceed with rawBody
    }

    const processedContent = await processMessage(messageBody.trim());
    
    const signalPrefix = getSignalPrefix(processedContent);
    
    const finalMessage = `${signalPrefix}[聚宝盆] ${processedContent}`;
    debugLog.push(`Final message: ${finalMessage}`);

    const isWecom = config.type === 'wecom' || config.type === 'jubaopen';
    const resp = await fetchWithTimeout(config.url, {
      method: 'POST',
      headers: { 'Content-Type': isWecom ? 'application/json' : 'text/plain; charset=utf-8' },
      body: isWecom
        ? JSON.stringify({ msgtype: 'markdown', markdown: { content: finalMessage } })
        : finalMessage,
    });

    if (!resp.ok) {
        const errorText = await resp.text();
        debugLog.push(`Forward failed with status ${resp.status}: ${errorText}`);
        throw new Error('Forward failed');
    }

    return res.status(200).json({ success: true, processed: processedContent });

  } catch (error) {
    console.error("Handler Error:", error);
    debugLog.push(`Error: ${error.message}`);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message, log: debugLog });
  }
}

