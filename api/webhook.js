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
        console.log(`[DEBUG] No market prefix found for stock code: ${stockCode}. (Ignoring, likely not A-share/HK)`);
        return null;
    }
    console.log(`[DEBUG] Identified market '${marketPrefix}' for stock code: ${stockCode}`);
    let chineseName = await getStockNameFromSina(stockCode, marketPrefix);
    if (chineseName) return chineseName;
    chineseName = await getStockNameFromTencent(stockCode, marketPrefix);
    return chineseName;
}

// --- Message Processing Function ---
async function processMessage(body) {
    let messageToProcess = body;

    // --- Pre-formatter for single-line signals (Robust Version) ---
    if (!messageToProcess.includes('\n') && messageToProcess.includes('标的:') && messageToProcess.includes(',')) {
        console.log('[DEBUG] Single-line signal detected. Applying new, robust multi-line formatting.');
        
        let tempBody = messageToProcess;
        
        // Keywords that should always start a new line
        const keywords = ['周期:', '信号:', '级别:', '交易所时间:', '价格:', '原因:', '当前价格:'];
        
        // Step 1: Place a newline before each keyword, consuming any leading comma/space.
        keywords.forEach(keyword => {
            const regex = new RegExp(`[\\s,]*(${keyword})`, 'g');
            tempBody = tempBody.replace(regex, `\n$1`);
        });
        
        // Step 2: Replace any remaining commas (with optional following space) with a newline.
        tempBody = tempBody.replace(/,\s*/g, '\n');
        
        // Step 3: Final cleanup to ensure consistent formatting
        messageToProcess = tempBody.split('\n')
                                    .map(line => line.trim())
                                    .filter(line => line) // Remove any potential empty lines
                                    .join('\n');
        console.log(`[DEBUG] Pre-formatted message:\n${messageToProcess}`);
    }


    // --- Stock Name Enhancer ---
    const alreadyFormattedMatch = messageToProcess.match(/标的\s*[:：].*?[（(]\s*\d{5,6}\s*[)）]/);
    if (alreadyFormattedMatch) {
        console.log(`[DEBUG] Message appears to be already name-formatted. No further action needed.`);
        return messageToProcess;
    }

    const codeMatch = messageToProcess.match(/(标的\s*[:：]\s*\d{5,6})/);
    if (codeMatch) {
        const stringToReplace = codeMatch[0];
        const stockCode = stringToReplace.match(/\d{5,6}/)[0];

        console.log(`[DEBUG] Found code '${stockCode}' to process in block '${stringToReplace}'.`);
        
        const chineseName = await getChineseStockName(stockCode);
        console.log(`[DEBUG] Fetched stock name: '${chineseName}' for code '${stockCode}'`);

        if (chineseName) {
            const prefix = stringToReplace.substring(0, stringToReplace.indexOf(stockCode));
            const replacementString = `${prefix}${chineseName} （${stockCode}）`;
            const newBody = messageToProcess.replace(stringToReplace, replacementString);
            console.log(`[DEBUG] Content successfully replaced.`);
            return newBody;
        } else {
            console.log(`[DEBUG] No Chinese name found. Name will not be added.`);
        }
    } else {
        console.log('[DEBUG] No replaceable stock code found.');
    }

    return messageToProcess;
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

    // --- Apply all processing ---
    const finalContent = await processMessage(messageBody);

    // --- INTELLIGENT PAYLOAD FORMATTING ---
    console.log(`[DEBUG] Final content being sent: ${finalContent}`);
    let forwardResponse;
    if (destinationType === 'wecom') {
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


