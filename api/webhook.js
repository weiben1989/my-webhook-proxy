import fetch from "node-fetch";
import { URL } from 'url';

// Vercel/Next.js API route config
export const config = {
  api: {
    bodyParser: false,
  },
};

// --- Webhook Configuration ---
// The configuration is now a map of { "proxy_key": { "url": "...", "type": "..." } }
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
// (API functions remain unchanged)
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
        console.log(`[DEBUG] No market prefix found for stock code: ${stockCode}. (Ignoring, likely not A-share/HK)`);
        return null;
    }
    console.log(`[DEBUG] Identified market '${marketPrefix}' for stock code: ${stockCode}`);
    let chineseName = await getStockNameFromSina(stockCode, marketPrefix);
    if (chineseName) return chineseName;
    chineseName = await getStockNameFromTencent(stockCode, marketPrefix);
    return chineseName;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }
    
    const requestUrl = new URL(req.url, `https://${req.headers.host}`);
    const proxyKey = requestUrl.searchParams.get('key');

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
    console.log(`[DEBUG] Received message body: ${messageBody}`);

    let finalContent = messageBody;

    // --- MODIFICATION START ---
    // A precise, two-step approach to find and replace the stock code.
    let stockCode = null;
    let stringToReplace = '';

    // Step 1: Check if the message is already formatted with a name and parenthesis. If so, do nothing.
    // This regex looks for "标的:", then any characters, then a parenthesis with a 5-6 digit code inside.
    const alreadyFormattedMatch = messageBody.match(/标的\s*[:：].*?[（(]\s*\d{5,6}\s*[)）]/);
    if (alreadyFormattedMatch) {
        console.log(`[DEBUG] Message appears to be already formatted. No action taken.`);
        stockCode = null; // Ensure we skip the replacement logic by nullifying stockCode
    } else {
        // Step 2: If not formatted, find a standalone code to replace.
        // This regex captures the code (group 1) that is preceded by "标的:".
        // The lookahead (?=[,\s]|$) ensures it's followed by a comma, space, or end of line, without capturing it.
        const codeMatch = messageBody.match(/标的\s*[:：]\s*(\d{5,6})(?=[,\s]|$)/);
        if (codeMatch) {
            stockCode = codeMatch[1]; // The code itself, e.g., "000819"
            stringToReplace = stockCode; // We will replace only the code number.
            console.log(`[DEBUG] Found code to replace: '${stockCode}'`);
        }
    }

    if (!stockCode && !alreadyFormattedMatch) {
        console.log('[DEBUG] No replaceable stock code found.');
    }

    if (stockCode) {
        const chineseName = await getChineseStockName(stockCode);
        console.log(`[DEBUG] Fetched stock name: '${chineseName}' for code '${stockCode}'`);
        
        if (chineseName) {
            // The replacement string now includes the name and the code in full-width parentheses.
            const replacementString = `${chineseName} （${stockCode}）`;
            // Since stringToReplace is just the code, this will result in the desired format:
            // "标的: 000819," becomes "标的: 岳阳兴长 （000819）,"
            finalContent = messageBody.replace(stringToReplace, replacementString);
            console.log(`[DEBUG] Content successfully replaced.`);
        } else {
            console.log(`[DEBUG] No Chinese name found. Content will not be replaced.`);
        }
    }
    // --- MODIFICATION END ---

    // --- INTELLIGENT PAYLOAD FORMATTING ---
    console.log(`[DEBUG] Final content being sent: ${finalContent}`);
    let forwardResponse;
    if (destinationType === 'wecom') {
        // Format for Enterprise WeChat (WeCom)
        const payload = {
            msgtype: 'markdown',
            markdown: { content: finalContent },
        };
        forwardResponse = await fetch(finalWebhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    } else {
        // Default to raw text
        forwardResponse = await fetch(finalWebhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            body: finalContent,
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

