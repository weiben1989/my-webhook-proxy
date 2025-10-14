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

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

// --- 股票名称查询（只查A股/港股） ---
async function getStockNameFromSina(stockCode, marketPrefix) {
    const url = `https://hq.sinajs.cn/list=${marketPrefix}${stockCode}`;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1500);
        
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        
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
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1500);
        
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        
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

// --- 消息处理：只处理A股代码 ---
async function processMessage(body) {
    // 只匹配纯数字的股票代码（5-6位）
    const match = body.match(/标的\s*[:：]\s*(\d{5,6})/);
    
    if (!match) {
        // 不是股票代码，直接返回原文
        return body;
    }
    
    const stockCode = match[1];
    const chineseName = await getChineseStockName(stockCode);
    
    if (!chineseName) {
        // 没查到名称，返回原文
        return body;
    }
    
    // 替换格式: "标的: 159565" → "标的:创业板ETF(159565)"
    return body.replace(match[0], `标的:${chineseName}(${stockCode})`);
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }
    
    const requestUrl = new URL(req.url, `https://${req.headers.host}`);
    const proxyKey = requestUrl.searchParams.get('key');

    if (!proxyKey) {
        return res.status(400).json({ error: "Missing key" });
    }
    
    const proxyConfig = webhookMap[proxyKey];
    if (!proxyConfig || !proxyConfig.url) {
        return res.status(404).json({ error: "Key not found" });
    }
    
    const finalWebhookUrl = proxyConfig.url;
    const destinationType = proxyConfig.type || 'raw';

    const rawBody = (await getRawBody(req)).toString('utf8');
    
    let messageBody;
    try {
        const alertData = JSON.parse(rawBody);
        messageBody = Object.entries(alertData)
          .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
          .join('\n');
    } catch (e) {
        messageBody = rawBody;
    }
    
    const trimmedBody = messageBody.trim();
    
    // 处理消息（只处理A股代码）
    const processedContent = await processMessage(trimmedBody);
    const finalMessage = `✅ ${processedContent}`;

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

    if (!forwardResponse.ok) {
        const responseText = await forwardResponse.text();
        console.error(`Forward failed: ${forwardResponse.status} - ${responseText}`);
        return res.status(500).json({ error: 'Forward failed' });
    }

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
