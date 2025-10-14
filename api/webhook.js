import fetch from "node-fetch";
import { URL } from 'url';

export const config = {
  api: {
    bodyParser: false,
  },
};

// --- Webhook Configuration ---
let webhookMap = {};
try {
    if (process.env.WEBHOOK_CONFIG) {
        webhookMap = JSON.parse(process.env.WEBHOOK_CONFIG);
    }
} catch (error) {
    console.error("Config parse error:", error);
}

// --- 品种映射表 ---
const SYMBOL_MAP = {
    // 期货
    'CL1!': '轻质原油期货',
    'GC1!': '黄金期货',
    'SI1!': '白银期货',
    'HG1!': '铜期货',
    'NG1!': '天然气期货',
    'RB1!': '螺纹钢期货',
    'IODEX': '铁矿石期货',
    
    // 外汇
    'DXY': '美元指数',
    'XAUUSD': '黄金现货/美元',
    'XAGUSD': '白银/美元',
    'EURUSD': '欧元/美元',
    'GBPUSD': '英镑/美元',
    'USDJPY': '美元/日元',
    'AUDUSD': '澳元/美元',
    
    // 加密货币
    'BTCUSDT': '比特币/USDT',
    'BTCUSD': '比特币/美元',
    'ETHUSDT': '以太坊/USDT',
    'ETHUSD': '以太坊/美元',
    
    // 美股指数/债券
    'US10Y': '美国10年期国债收益率',
    'US02Y': '美国2年期国债收益率',
    'SPX': '标普500指数',
    'NDX': '纳斯达克100指数',
    
    // 其他
    'HG_CUSD': '铜差价合约(美元/磅)',
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

// --- 股票名称查询（保留原有功能） ---
async function getStockNameFromSina(stockCode, marketPrefix) {
    const url = `https://hq.sinajs.cn/list=${marketPrefix}${stockCode}`;
    try {
        const response = await fetch(url, { timeout: 3000 });
        if (!response.ok) return null;
        const responseBuffer = await response.arrayBuffer();
        const responseText = new TextDecoder('gbk').decode(responseBuffer);
        const parts = responseText.split('"');
        if (parts.length > 1 && parts[1] && parts[1].length > 1) {
            return parts[1].split(',')[0];
        }
        return null;
    } catch (error) {
        return null;
    }
}

async function getStockNameFromTencent(stockCode, marketPrefix) {
    let finalStockCode = stockCode;
    if (marketPrefix === 'hk') {
        finalStockCode = stockCode.padStart(5, '0');
    }
    const url = `https://qt.gtimg.cn/q=${marketPrefix}${finalStockCode}`;
    try {
        const response = await fetch(url, { timeout: 3000 });
        if (!response.ok) return null;
        const responseBuffer = await response.arrayBuffer();
        const responseText = new TextDecoder('gbk').decode(responseBuffer);
        const parts = responseText.split('~');
        if (parts.length > 1 && parts[1]) {
            return parts[1];
        }
        return null;
    } catch (error) {
        return null;
    }
}

async function getChineseStockName(stockCode) {
    let marketPrefix;
    if (stockCode.length <= 5 && /^\d+$/.test(stockCode)) {
        marketPrefix = 'hk';
    } else if (stockCode.length === 6 && /^\d+$/.test(stockCode)) {
        if (stockCode.startsWith('6') || stockCode.startsWith('5')) {
            marketPrefix = 'sh';
        } else if (stockCode.startsWith('0') || stockCode.startsWith('3') || stockCode.startsWith('1')) {
            marketPrefix = 'sz';
        }
    }
    if (!marketPrefix) return null;
    
    let chineseName = await getStockNameFromSina(stockCode, marketPrefix);
    if (chineseName) return chineseName;
    
    chineseName = await getStockNameFromTencent(stockCode, marketPrefix);
    return chineseName;
}

// --- 智能识别并转换品种名称 ---
async function getSymbolName(symbol, debugLog) {
    debugLog.push(`Identifying symbol: ${symbol}`);
    
    // 1. 先检查映射表
    if (SYMBOL_MAP[symbol]) {
        debugLog.push(`Found in map: ${SYMBOL_MAP[symbol]}`);
        return SYMBOL_MAP[symbol];
    }
    
    // 2. 如果是纯数字，可能是股票代码
    if (/^\d{5,6}$/.test(symbol)) {
        debugLog.push('Detected as stock code, querying API...');
        const stockName = await getChineseStockName(symbol);
        if (stockName) {
            debugLog.push(`Stock API returned: ${stockName}`);
            return stockName;
        }
    }
    
    // 3. 都没找到，返回 null
    debugLog.push('Symbol not found in map or API');
    return null;
}

async function processMessage(body, debugLog) {
    debugLog.push(`Processing body: ${body}`);
    
    // 匹配 "标的: XXX" 格式，支持各种符号（字母、数字、感叹号等）
    const match = body.match(/标的\s*[:：]\s*([A-Za-z0-9!_\-]+)/);
    
    if (!match) {
        debugLog.push('No symbol pattern found');
        return body;
    }
    
    const symbol = match[1];  // 例如: "CL1!", "159565", "BTCUSDT"
    debugLog.push(`Extracted symbol: ${symbol}`);
    
    const chineseName = await getSymbolName(symbol, debugLog);
    
    if (!chineseName) {
        debugLog.push('No Chinese name found, returning original');
        return body;
    }
    
    // 替换格式: "标的: CL1!" → "标的:轻质原油期货(CL1!)"
    const result = body.replace(match[0], `标的:${chineseName}(${symbol})`);
    debugLog.push(`Final result: ${result}`);
    return result;
}

export default async function handler(req, res) {
  const debugLog = [];
  
  try {
    debugLog.push('Handler started');
    
    if (req.method !== 'POST') {
      debugLog.push('Not POST method');
      return res.status(405).json({ error: 'Method Not Allowed', debug: debugLog });
    }
    
    const requestUrl = new URL(req.url, `https://${req.headers.host}`);
    const proxyKey = requestUrl.searchParams.get('key');
    debugLog.push(`Key: ${proxyKey}`);

    if (!proxyKey) {
        return res.status(400).json({ error: "Missing key", debug: debugLog });
    }
    
    const proxyConfig = webhookMap[proxyKey];
    if (!proxyConfig || !proxyConfig.url) {
        debugLog.push(`Config not found for key: ${proxyKey}`);
        return res.status(404).json({ error: "Key not found", debug: debugLog });
    }
    
    const finalWebhookUrl = proxyConfig.url;
    const destinationType = proxyConfig.type || 'raw';
    debugLog.push(`Destination: ${destinationType}`);

    const rawBody = (await getRawBody(req)).toString('utf8');
    debugLog.push(`Raw body: ${rawBody}`);
    
    let messageBody;
    try {
        const alertData = JSON.parse(rawBody);
        messageBody = Object.entries(alertData)
          .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
          .join('\n');
        debugLog.push('Parsed as JSON');
    } catch (e) {
        messageBody = rawBody;
        debugLog.push('Using raw body');
    }
    
    const trimmedBody = messageBody.trim();

    const processedContent = await processMessage(trimmedBody, debugLog);
    const finalMessage = `✅ ${processedContent}`;
    debugLog.push(`Final message: ${finalMessage}`);

    let forwardResponse;
    if (destinationType === 'wecom') {
        const payload = {
            msgtype: 'markdown',
            markdown: { content: finalMessage },
        };
        forwardResponse = await fetch(finalWebhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    } else {
        forwardResponse = await fetch(finalWebhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            body: finalMessage,
        });
    }

    const responseText = await forwardResponse.text();
    debugLog.push(`Forward status: ${forwardResponse.status}`);

    console.log('DEBUG LOG:', debugLog.join(' | '));

    if (!forwardResponse.ok) {
        return res.status(500).json({ 
            error: 'Forward failed', 
            debug: debugLog
        });
    }

    return res.status(200).json({ 
        success: true, 
        processed: processedContent,
        debug: debugLog 
    });

  } catch (error) {
    debugLog.push(`Error: ${error.message}`);
    console.error('Error:', error);
    return res.status(500).json({ 
        error: error.message, 
        debug: debugLog
    });
  }
}
