import fetch from "node-fetch";
import { URL } from 'url';

export const config = {
  api: {
    bodyParser: false,
  },
};

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

async function processMessage(body, debugLog) {
    debugLog.push(`Processing body: ${body}`);
    
    const match = body.match(/标的\s*[:：]\s*(\d{5,6})/);
    
    if (!match) {
        debugLog.push('No stock code found');
        return body;
    }
    
    const stockCode = match[1];
    debugLog.push(`Found stock code: ${stockCode}`);
    
    const chineseName = await getChineseStockName(stockCode);
    debugLog.push(`Stock name: ${chineseName || 'NOT FOUND'}`);
    
    if (!chineseName) {
        return body;
    }
    
    const result = body.replace(match[0], `标的:${chineseName}(${stockCode})`);
    debugLog.push(`Replaced result: ${result}`);
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
        debugLog.push(`Available keys: ${Object.keys(webhookMap).join(', ')}`);
        return res.status(404).json({ error: "Key not found", debug: debugLog });
    }
    
    const finalWebhookUrl = proxyConfig.url;
    const destinationType = proxyConfig.type || 'raw';
    debugLog.push(`Destination: ${destinationType} -> ${finalWebhookUrl}`);

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
    debugLog.push(`Trimmed: ${trimmedBody}`);

    const processedContent = await processMessage(trimmedBody, debugLog);
    const finalMessage = `✅ ${processedContent}`;
    debugLog.push(`Final: ${finalMessage}`);

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
    debugLog.push(`Forward response: ${responseText}`);

    // 把调试信息也输出到 console
    console.log('DEBUG LOG:', debugLog.join(' | '));

    if (!forwardResponse.ok) {
        return res.status(500).json({ 
            error: 'Forward failed', 
            debug: debugLog,
            forwardStatus: forwardResponse.status,
            forwardResponse: responseText
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
        debug: debugLog,
        stack: error.stack
    });
  }
}
