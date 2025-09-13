import fetch from "node-fetch";
import { URL } from 'url';

// Vercel/Next.js API route config
export const config = {
  api: {
    bodyParser: false,
  },
};

// --- Webhook Configuration ---
// The configuration is now a map of { "proxy_key": "final_webhook_url" }
// It is read from the Vercel environment variable WEBHOOK_CONFIG.
let webhookMap = {};
try {
    if (process.env.WEBHOOK_CONFIG) {
        webhookMap = JSON.parse(process.env.WEBHOOK_CONFIG);
    } else {
        console.warn("WARN: WEBHOOK_CONFIG environment variable is not set. The forwarder will not work.");
    }
} catch (error) {
    console.error("FATAL: Could not parse WEBHOOK_CONFIG. Please check its JSON format.", error);
}

// Helper function to read the raw request body as a buffer
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
    console.error(`[DEBUG] Sina API Error:`, error.message);
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
    console.error(`[DEBUG] Tencent API Error:`, error.message);
    return null;
  }
}

async function getChineseStockName(stockCode) {
    let marketPrefix;
    // Rule for Hong Kong stocks: up to 5 digits, purely numeric
    if (stockCode.length <= 5 && /^\d+$/.test(stockCode)) {
        marketPrefix = 'hk';
    } 
    // Rule for A-shares: 6 digits, purely numeric
    else if (stockCode.length === 6 && /^\d+$/.test(stockCode)) {
        if (stockCode.startsWith('6') || stockCode.startsWith('5')) { // SH main board & ETFs
            marketPrefix = 'sh';
        } else if (stockCode.startsWith('0') || stockCode.startsWith('3') || stockCode.startsWith('1')) { // SZ main board, ChiNext, ETFs
            marketPrefix = 'sz';
        }
    }

    if (!marketPrefix) {
        console.log(`[DEBUG] No market rule for code: ${stockCode}`);
        return null;
    }

    let chineseName = await getStockNameFromSina(stockCode, marketPrefix);
    if (chineseName) return chineseName;

    console.log(`[DEBUG] Sina failed for ${stockCode}, trying Tencent.`);
    chineseName = await getStockNameFromTencent(stockCode, marketPrefix);
    return chineseName;
}


export default async function handler(req, res) {
  console.log(`\n--- New Request Received at ${new Date().toISOString()} ---`);
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }
    
    // Step 1: Find the final destination URL using the 'key' parameter
    const requestUrl = new URL(req.url, `https://${req.headers.host}`);
    const proxyKey = requestUrl.searchParams.get('key');

    if (!proxyKey) {
        return res.status(400).json({ error: "Missing 'key' parameter in the URL." });
    }

    const finalWebhookUrl = webhookMap[proxyKey];

    if (!finalWebhookUrl) {
        return res.status(404).json({ error: `Proxy key '${proxyKey}' not found in configuration.` });
    }
    
    console.log(`[PROXY] Request for key '${proxyKey}' will be forwarded to ${finalWebhookUrl.substring(0,50)}...`);

    // Step 2: Process the incoming message body (translation, etc.)
    const rawBodyBuffer = await getRawBody(req);
    const rawBody = rawBodyBuffer.toString('utf8');
    
    let messageBody;
    try {
        const alertData = JSON.parse(rawBody);
        messageBody = Object.entries(alertData)
          .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
          .join('\n');
    } catch (e) {
        messageBody = rawBody;
    }

    let finalContent = messageBody;
    const stockMatch = messageBody.match(/标的:.*\(([^)]+)\)/);

    if (stockMatch && stockMatch[1]) {
        const stockCode = stockMatch[1].trim();
        const chineseName = await getChineseStockName(stockCode);
        if (chineseName) {
            finalContent = messageBody.replace(
                /标的:.*?\n/, 
                `标的: ${chineseName} (${stockCode})\n`
            );
        }
    }

    // Step 3: Send the processed message to the final destination
    const payload = {
        msgtype: 'markdown',
        markdown: { content: finalContent },
    };

    const forwardResponse = await fetch(finalWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!forwardResponse.ok) {
        console.error(`[PROXY] Failed to forward to final destination. Status: ${forwardResponse.status}`);
    }

    return res.status(200).json({ success: true, message: `Alert processed and forwarded for key '${proxyKey}'.` });

  } catch (error)
 {
    console.error('Webhook Error:', error.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
