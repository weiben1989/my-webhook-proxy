// Vercel 平台配置
module.exports.config = {
  api: {
    bodyParser: false, // 禁用默认解析，手动处理 Buffer
  },
};

/**
 * 环境变量配置说明:
 * process.env.WEBHOOK_CONFIG 格式:
 * {
 * "mykey1": { "url": "https://qyapi.weixin.qq.com/...", "type": "wecom" },
 * "mykey2": { "url": "https://...", "type": "raw" }
 * }
 */

// --- 静态品种映射表 ---
const SYMBOL_MAP = {
  // A股指数
  '000001': '上证指数', '399001': '深证成指', '399006': '创业板指',
  '000300': '沪深300', '000016': '上证50', '000688': '科创50',
  '000905': '中证500', '000852': '中证1000', '399303': '国证2000',
  // 期货
  'CL1!': '轻质原油主连', 'GC1!': '黄金主连', 'SI1!': '白银主连',
  'HG1!': '铜主连', 'NG1!': '天然气主连', 'RB1!': '螺纹钢主连', 'IODEX': '铁矿石',
  // 外汇
  'DXY': '美元指数', 'XAUUSD': '现货黄金', 'XAGUSD': '现货白银',
  'EURUSD': '欧元/美元', 'GBPUSD': '英镑/美元', 'USDJPY': '美元/日元',
  // 加密货币
  'BTCUSDT': '比特币/USDT', 'BTCUSD': '比特币/美元',
  'ETHUSDT': '以太坊/USDT', 'ETHUSD': '以太坊/美元',
  // 美股/债券
  'US10Y': '美债10年', 'US02Y': '美债2年',
  'SPX': '标普500', 'NDX': '纳指100',
};

// --- 工具函数 ---

// 获取原始请求体 Buffer
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

// 带超时的 fetch (Node 18+ 原生支持 fetch，无需 node-fetch)
async function fetchWithTimeout(url, options = {}) {
  const { timeout = 3500, ...rest } = options;
  // Node 18+ 原生支持 AbortController
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...rest, signal: controller.signal });
    return response;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeout}ms`);
    }
    throw error;
  } finally {
    clearTimeout(id);
  }
}

// --- 股票名称查询模块 ---
const gbDecoder = new TextDecoder('gb18030');

async function getStockNameFromSina(stockCode, marketPrefix) {
  // Sina 接口返回数据格式: var hq_str_sh600000="浦发银行,..."
  const url = `https://hq.sinajs.cn/list=${marketPrefix}${stockCode}`;
  try {
    const resp = await fetchWithTimeout(url);
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    const text = gbDecoder.decode(buf);
    // 简单校验返回内容是否有效
    if (!text.includes('=')) return null;
    
    const content = text.split('"')[1];
    if (!content) return null;
    return content.split(',')[0]?.trim();
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
    // 腾讯返回格式: v_sh600000="1~浦发银行~..."
    const parts = text.split('~');
    return parts.length > 2 ? parts[1]?.trim() : null;
  } catch {
    return null;
  }
}

async function getChineseStockName(stockCode) {
  let marketPrefix = null;
  // 简单的正则判断市场
  if (/^\d{1,5}$/.test(stockCode)) marketPrefix = 'hk'; // 港股通常5位或以下
  else if (/^\d{6}$/.test(stockCode)) {
    if (stockCode.startsWith('6') || stockCode.startsWith('5') || stockCode.startsWith('9')) marketPrefix = 'sh';
    else if (stockCode.startsWith('0') || stockCode.startsWith('3') || stockCode.startsWith('1')) marketPrefix = 'sz';
    else if (stockCode.startsWith('4') || stockCode.startsWith('8')) marketPrefix = 'bj'; // 北交所
  }
  
  if (!marketPrefix) return null;

  // 优先新浪，失败降级到腾讯
  return (await getStockNameFromSina(stockCode, marketPrefix)) ?? 
         (await getStockNameFromTencent(stockCode, marketPrefix));
}

// --- 核心处理逻辑 ---

function getSignalPrefix(message) {
  // 转小写比较，提高匹配率
  const lowerMsg = message.toLowerCase();
  
  if (/(止损|止盈|stop loss|take profit|sl|tp|平仓|close)/.test(lowerMsg)) return '⚠️ ';
  if (/(多|buy|long|看涨|做多|多头)/.test(lowerMsg)) return '🟢 ';
  if (/(空|sell|short|看跌|做空|空头)/.test(lowerMsg)) return '🔴 ';
  
  return ''; 
}

/**
 * 从文本或对象中提取标的代码
 * 支持格式: 
 * 1. 文本: "标的: 000001", "Symbol: BTCUSDT"
 * 2. 混合: "标的: JiangXi Tianxin (603235)" -> 提取 603235
 * 3. JSON字段: { "ticker": "...", "symbol": "...", "code": "..." }
 */
async function extractAndEnrich(rawBodyString, jsonObject) {
  let rawSymbolText = null; // 原始提取到的文本（可能包含长名称）
  let cleanSymbol = null;   // 清洗后的纯代码（用于查询）
  let originalPattern = null; // 用于最终替换文本

  // 1. 尝试从 JSON 对象中直接获取 (更精准)
  if (jsonObject) {
    const keys = ['symbol', 'ticker', 'code', 'instrument', '标的'];
    for (const key of keys) {
      const foundKey = Object.keys(jsonObject).find(k => k.toLowerCase() === key);
      if (foundKey && jsonObject[foundKey]) {
        rawSymbolText = String(jsonObject[foundKey]).trim();
        originalPattern = rawSymbolText;
        break;
      }
    }
  }

  // 2. 如果 JSON 没找到，或者不是 JSON，尝试正则匹配全文
  if (!rawSymbolText) {
    // 修正正则：使用 .+ 匹配冒号后的整行内容，解决英文长名称带空格的问题
    const regex = /(?:标的|Symbol|Ticker|Code)\s*[:：]\s*(.+)/i;
    const match = rawBodyString.match(regex);
    if (match) {
      originalPattern = match[0]; // 整个 "标的: xxx" 字符串
      rawSymbolText = match[1].trim(); // "JiangXi ... (603235)"
    }
  }

  // 如果找不到任何标的描述，直接返回原文
  if (!rawSymbolText) return rawBodyString;

  // --- 二次提取逻辑 (核心修复) ---
  // 检查 rawSymbolText 是否包含括号内的代码，例如 "Name (603235)"
  // 增加 \s* 允许括号内有空格，增强健壮性
  const parenMatch = rawSymbolText.match(/\(\s*([\w!.]+)\s*\)/);
  if (parenMatch) {
    cleanSymbol = parenMatch[1]; // 提取括号内的 603235
  } else {
    // 如果没有括号，尝试提取纯数字（针对A股）
    const digitMatch = rawSymbolText.match(/(\d{6})/);
    if (digitMatch) {
      cleanSymbol = digitMatch[1];
    } else {
      // 都没有，就以前几个单词作为代码（兜底）
      cleanSymbol = rawSymbolText.split(' ')[0];
    }
  }

  // 3. 获取名称
  let name = SYMBOL_MAP[cleanSymbol];
  // 如果没在静态表中，且是纯数字或看起来像股票代码，去查API
  if (!name && (/^\d{1,6}$/.test(cleanSymbol) || /^[A-Z]{1,5}$/.test(cleanSymbol))) {
    name = await getChineseStockName(cleanSymbol);
  }

  // 4. 组装最终文本
  if (name) {
    // 最终显示格式：**天新药业(603235)**
    const enrichedText = `**${name}(${cleanSymbol})**`;
    
    // 如果是通过正则匹配到的文本模式
    if (originalPattern && rawBodyString.includes(originalPattern)) {
      // 这里的 originalPattern 可能是 "标的: JiangXi ... (603235)"
      // 我们需要把整个 "JiangXi ... (603235)" 替换掉
      // 重新构建替换后的字符串：保留前缀（标的:），替换内容
      
      if (originalPattern.includes(':') || originalPattern.includes('：')) {
        // 如果 originalPattern 是整行 "标的: xxx"，我们替换冒号后的部分
        const splitArr = originalPattern.split(/[:：]/);
        const prefix = splitArr[0];
        return rawBodyString.replace(originalPattern, `${prefix}: ${enrichedText}`);
      } else {
        // 如果只是值替换 (JSON场景)
        return rawBodyString.replace(originalPattern, enrichedText);
      }
    }
    
    // 兜底：直接加在开头
    return `标的: ${enrichedText}\n` + rawBodyString;
  }

  return rawBodyString;
}

// --- 主 Handler ---
module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // 1. 获取配置
    const key = req.query.key;
    let webhookMap = {};
    if (process.env.WEBHOOK_CONFIG) {
      try {
        webhookMap = JSON.parse(process.env.WEBHOOK_CONFIG);
      } catch (e) {
        console.error("WEBHOOK_CONFIG 解析失败");
      }
    }
    
    const config = key ? webhookMap[key] : undefined;
    if (!config?.url) {
      return res.status(404).json({ error: `Key not found or invalid config.` });
    }

    // 2. 获取 Body
    const rawBuffer = await getRawBody(req);
    const rawBodyString = rawBuffer.toString('utf8');
    
    let jsonBody = null;
    let messageToProcess = rawBodyString;

    try {
      jsonBody = JSON.parse(rawBodyString);
      // 如果是 JSON，转换成 key: value 形式作为默认消息体，但保留 jsonBody 对象用于精准提取
      messageToProcess = Object.entries(jsonBody)
        .map(([k, v]) => {
          // 如果值是对象，简单的 JSON stringify 一下，避免 [object Object]
          const valStr = typeof v === 'object' ? JSON.stringify(v) : v;
          return `${k}: ${valStr}`;
        })
        .join('\n'); // 使用换行符比逗号更清晰
    } catch {
      // 不是 JSON，保持原样
    }

    // 3. 处理消息 (增强股票名称)
    // 传入 rawBodyString (原文) 和 jsonBody (对象) 供双重判断
    // 注意：这里我们主要处理 messageToProcess 这个转换后的文本
    const processedContent = await extractAndEnrich(messageToProcess, jsonBody);

    // 4. 添加信号前缀
    const signalPrefix = getSignalPrefix(processedContent);
    const finalMessage = `${signalPrefix}${processedContent}`;

    // 5. 发送请求
    const isWecom = config.type === 'wecom' || config.type === 'jubaopen';
    const payload = isWecom
      ? JSON.stringify({ msgtype: 'markdown', markdown: { content: finalMessage } })
      : finalMessage;

    const resp = await fetchWithTimeout(config.url, {
      method: 'POST',
      headers: { 'Content-Type': isWecom ? 'application/json' : 'text/plain; charset=utf-8' },
      body: payload,
    });

    if (!resp.ok) {
      return res.status(resp.status).send(await resp.text());
    }

    return res.status(200).json({ success: true, symbol_enriched: processedContent !== messageToProcess });

  } catch (error) {
    console.error("Handler Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
