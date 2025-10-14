import fetch from "node-fetch";
import { URL } from 'url';

// Vercel/Next.js API route config
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
    } else {
        console.warn("WARN: WEBHOOK_CONFIG environment variable is not set.");
    }
} catch (error) {
    console.error("FATAL: Could not parse WEBHOOK_CONFIG. Please check its JSON format.", error);
}

// Helper function to read the raw request body
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

// --- Stock Name API Helpers ---
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
        console.error(`[DEBUG] Sina API call failed for ${stockCode}`, error);
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
        console.error(`[DEBUG] Tencent API call failed for ${stockCode}`, error);
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
    if (!marketPrefix) {
        console.log(`[DEBUG] No market prefix found for stock code: ${stockCode}.`);
        return null;
    }
    console.log(`[DEBUG] Identified market '${marketPrefix}' for stock code: ${stockCode}`);
    let chineseName = await getStockNameFromSina(stockCode, marketPrefix);
    if (chineseName) return chineseName;
    chineseName = await getStockNameFromTencent(stockCode, marketPrefix);
    return chineseName;
}

// --- Message Processing Function with Debug Info ---
async function processMessage(body) {
    let debugReport = [];
    debugReport.push(`1. Original Body (raw):\n---\n${body}\n---`);
    debugReport.push(`2. Body as Hex to see hidden chars:\n---\n${Buffer.from(body).toString('hex')}\n---`);
    
    let messageToProcess = body;

    // --- Pre-formatter for single-line signals ---
    if (!messageToProcess.includes('\n') && messageToProcess.includes('标的:') && messageToProcess.includes(',')) {
        debugReport.push("3. Pre-formatter Triggered: YES");
        let tempBody = messageToProcess;
        const keywords = ['周期:', '信号:', '级别:', '交易所时间:', '价格:', '原因:', '当前价格:'];
        keywords.forEach(keyword => {
            const regex = new RegExp(`[\\s,]*(${keyword})`, 'g');
            tempBody = tempBody.replace(regex, `\n$1`);
        });
        tempBody = tempBody.replace(/,\s*/g, '\n');
        messageToProcess = tempBody.split('\n').map(line => line.trim()).filter(line => line).join('\n');
        debugReport.push(`4. Pre-formatted Message:\n---\n${messageToProcess}\n---`);
    } else {
        debugReport.push("3. Pre-formatter Triggered: NO. Reason: Body already contains newline or is not a known single-line format.");
    }

    // --- Stock Name Enhancer ---
    const alreadyFormattedMatch = messageToProcess.match(/标的\s*[:：].*?[（(]\s*\d{5,6}\s*[)）]/);
    if (alreadyFormattedMatch) {
        debugReport.push("5. Name Enhancer: SKIPPED (already formatted).");
        return { finalContent: messageToProcess, debugInfo: debugReport.join('\n') };
    }

    const codeMatch = messageToProcess.match(/(标的\s*[:：]\s*\d{5,6})/);
    if (codeMatch) {
        const stringToReplace = codeMatch[0];
        const stockCode = stringToReplace.match(/\d{5,6}/)[0];
        debugReport.push(`5. Name Enhancer: FOUND code '${stockCode}'.`);

        const chineseName = await getChineseStockName(stockCode);
        if (chineseName) {
            debugReport.push(`6. API Result: SUCCESS, found name '${chineseName}'.`);
            const prefix = stringToReplace.substring(0, stringToReplace.indexOf(stockCode));
            const replacementString = `${prefix}${chineseName} （${stockCode}）`;
            messageToProcess = messageToProcess.replace(stringToReplace, replacementString);
        } else {
            debugReport.push(`6. API Result: FAILED, no name found.`);
        }
    } else {
        debugReport.push("5. Name Enhancer: SKIPPED (no code found).");
    }

    return { finalContent: messageToProcess, debugInfo: debugReport.join('\n') };
}


export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }
    
    const requestUrl = new URL(req.url, `https://${req.headers.host}`);
    const proxyKey = requestUrl.searchParams.get('key');
    const isDebugMode = requestUrl.searchParams.get('debug') === 'true';

    if (!proxyKey) {
        return res.status(400).json({ error: "Missing 'key' parameter." });
    }
    const proxyConfig = webhookMap[proxyKey];
    if (!proxyConfig || !proxyConfig.url) {
        return res.status(404).json({ error: `Proxy key '${proxyKey}' not found or misconfigured.` });
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
    
    // CRITICAL FIX: Trim the body before any processing
    const trimmedBody = messageBody.trim();
    console.log(`[DEBUG] Received and trimmed message body: ${trimmedBody}`);

    // --- Apply all processing ---
    const { finalContent, debugInfo } = await processMessage(trimmedBody);
    
    let messageToSend = finalContent;
    if (isDebugMode) {
        messageToSend += `\n\n--- 诊断报告 ---\n${debugInfo}`;
    }

    // --- INTELLIGENT PAYLOAD FORMATTING ---
    console.log(`[DEBUG] Final content being sent: ${messageToSend}`);
    let forwardResponse;
    if (destinationType === 'wecom') {
        const payload = {
            msgtype: 'markdown',
            markdown: { content: messageToSend },
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
            body: messageToSend,
        });
    }

    if (!forwardResponse.ok) {
        console.error(`[PROXY] Failed to forward. Key: ${proxyKey}, Type: ${destinationType}, Status: ${forwardResponse.status}, Body: ${await forwardResponse.text()}`);
    } else {
        console.log(`[PROXY] Successfully forwarded alert for key '${proxyKey}'.`);
    }

    return res.status(200).json({ success: true, message: `Alert processed for key '${proxyKey}'.` });

  } catch (error) {
    console.error('Webhook Error:', error.message, error.stack);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

