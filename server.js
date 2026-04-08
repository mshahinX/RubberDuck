require("dotenv").config();
const express = require("express");
const path = require("path");
const os = require("os");

const app = express();
const port = Number(process.env.PORT || 3000);
const openAiApiKey = process.env.OPENAI_API_KEY || "";
const openAiModel = process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini";
const requestHistory = [];
const maxHistoryItems = 40;

app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

function parseHexDataToBuffer(hexData) {
  const raw = String(hexData || "").trim();
  if (!raw) {
    return { error: "hexData is required." };
  }

  // Accept tokenized byte streams such as: "FF D8 0 10 4A ..."
  // This mirrors the Python regex approach that accepts 1-2 hex chars per token.
  const byteTokens = raw.match(/\b(?:0x)?[0-9A-Fa-f]{1,2}\b/g);
  if (byteTokens && byteTokens.length > 0) {
    const bytes = byteTokens.map((token) => parseInt(token.replace(/^0x/i, ""), 16));
    return { buffer: Buffer.from(bytes) };
  }

  // Fallback: accept continuous hex string with no separators.
  const normalizedHex = raw
    .replace(/0x/gi, "")
    .replace(/[^a-fA-F0-9]/g, "");

  if (!normalizedHex || normalizedHex.length % 2 !== 0) {
    return { error: "hexData must contain valid hex bytes." };
  }

  return { buffer: Buffer.from(normalizedHex, "hex") };
}

function extractJpegSegment(buffer) {
  const start = buffer.indexOf(Buffer.from([0xff, 0xd8]));
  if (start === -1) {
    return null;
  }

  const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
  if (end === -1) {
    return null;
  }

  return buffer.subarray(start, end + 2);
}

function detectMimeType(buffer) {
  if (buffer.length < 4) {
    return "image/png";
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }

  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return "image/gif";
  }

  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return "image/bmp";
  }

  if (buffer.length >= 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
    && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return "image/webp";
  }

  return "image/png";
}

function extractAnalysisText(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const outputItems = Array.isArray(payload.output) ? payload.output : [];
  const pieces = [];

  for (const item of outputItems) {
    const contentItems = Array.isArray(item?.content) ? item.content : [];
    for (const content of contentItems) {
      if (typeof content?.text === "string" && content.text.trim()) {
        pieces.push(content.text.trim());
      } else if (typeof content?.output_text === "string" && content.output_text.trim()) {
        pieces.push(content.output_text.trim());
      }
    }
  }

  return pieces.join("\n\n").trim();
}

function buildErrorResponse({ byteSize, mimeType, error, details }) {
  return {
    request: {
      byteSize: typeof byteSize === "number" ? byteSize : null,
      mimeType: typeof mimeType === "string" ? mimeType : null
    },
    reconstruction: {
      success: false,
      imageDataUrl: null,
      bytesReceived: null,
      mimeType: null,
      recovery: {
        usedJpegMarkers: false
      }
    },
    analysis: {
      enabled: Boolean(openAiApiKey),
      model: openAiModel,
      status: "skipped",
      text: null
    },
    error: {
      message: error,
      details: details || null
    },
    meta: {
      timestamp: new Date().toISOString()
    }
  };
}

function getCallerInfo(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  const callerIp = typeof forwardedFor === "string" && forwardedFor.length > 0
    ? forwardedFor.split(",")[0].trim()
    : req.socket.remoteAddress || "unknown";

  return {
    ip: callerIp,
    userAgent: req.get("user-agent") || "unknown"
  };
}

function addHistoryEntry(req, statusCode, payload) {
  const historyEntry = {
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    statusCode,
    caller: getCallerInfo(req),
    payload
  };

  requestHistory.unshift(historyEntry);
  if (requestHistory.length > maxHistoryItems) {
    requestHistory.length = maxHistoryItems;
  }

  return historyEntry;
}

function sendWithHistory(req, res, statusCode, payload) {
  const entry = addHistoryEntry(req, statusCode, payload);
  const responsePayload = {
    ...payload,
    meta: {
      ...(payload.meta || {}),
      historyId: entry.id
    }
  };

  return res.status(statusCode).json(responsePayload);
}

async function analyzeImageWithAi({ dataUrl, bytesReceived }) {
  if (!openAiApiKey) {
    return "AI analysis skipped. Add OPENAI_API_KEY in your environment to enable model analysis.";
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openAiApiKey}`
    },
    body: JSON.stringify({
      model: openAiModel,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "You are a rubber-duck debugger.",
                "Analyze this reconstructed image. If it contains code or an error screenshot:",
                "1) Summarize what you see.",
                "2) List likely root causes.",
                "3) Propose a fix with short actionable steps.",
                `Image bytes received: ${bytesReceived}.`
              ].join("\n")
            },
            {
              type: "input_image",
              image_url: dataUrl
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${details}`);
  }

  const payload = await response.json();
  const analysis = extractAnalysisText(payload);
  return analysis || "AI analysis completed, but no output text was returned.";
}

app.post("/api/reconstruct-analyze", async (req, res) => {
  try {
    const { byteSize, hexData, mimeType } = req.body || {};

    const parsed = parseHexDataToBuffer(hexData);
    if (parsed.error) {
      return sendWithHistory(req, res, 400, buildErrorResponse({
        byteSize,
        mimeType,
        error: parsed.error
      }));
    }

    let buffer = parsed.buffer;
    let usedJpegMarkersRecovery = false;
    let byteSizeMismatch = false;

    if (typeof byteSize === "number" && byteSize > 0 && buffer.length !== byteSize) {
      byteSizeMismatch = true;
      const extractedJpeg = extractJpegSegment(buffer);
      if (extractedJpeg && extractedJpeg.length === byteSize) {
        buffer = extractedJpeg;
        usedJpegMarkersRecovery = true;
        byteSizeMismatch = false;
      }
    }

    const detectedMime = detectMimeType(buffer);
    const safeMimeType = typeof mimeType === "string" && mimeType.startsWith("image/")
      ? mimeType
      : detectedMime;

    const actualByteSize = buffer.length;
    const dataUrl = `data:${safeMimeType};base64,${buffer.toString("base64")}`;
    const analysis = await analyzeImageWithAi({ dataUrl, bytesReceived: actualByteSize });
    const analysisWasSkipped = analysis.startsWith("AI analysis skipped.");

    return sendWithHistory(req, res, 200, {
      request: {
        byteSize: typeof byteSize === "number" ? byteSize : null,
        mimeType: safeMimeType
      },
      reconstruction: {
        success: true,
        imageDataUrl: dataUrl,
        bytesReceived: actualByteSize,
        mimeType: safeMimeType,
        mimeDetected: detectedMime,
        recovery: {
          usedJpegMarkers: usedJpegMarkersRecovery,
          byteSizeMismatch
        }
      },
      analysis: {
        enabled: Boolean(openAiApiKey),
        model: openAiModel,
        status: analysisWasSkipped ? "skipped" : "completed",
        text: analysis
      },
      error: null,
      meta: {
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error";
    return sendWithHistory(req, res, 500, buildErrorResponse({
      error: message
    }));
  }
});

app.get("/api/received-data", (req, res) => {
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(Math.floor(requestedLimit), maxHistoryItems)
    : 15;

  return res.json({
    items: requestHistory.slice(0, limit),
    total: requestHistory.length,
    limit,
    maxHistoryItems
  });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, "0.0.0.0", () => {
  const nets = os.networkInterfaces();
  const lanAddresses = Object.values(nets)
    .flat()
    .filter((iface) => iface && iface.family === "IPv4" && !iface.internal)
    .map((iface) => iface.address);

  console.log(`Rubber Duck Debugger running on http://localhost:${port}`);
  for (const addr of lanAddresses) {
    console.log(`  Network: http://${addr}:${port}`);
  }
});
