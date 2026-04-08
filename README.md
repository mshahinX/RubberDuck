# Rubber Duck Debugger (MVP)

This app reconstructs an image from `byteSize + hexData`, sends it to an AI model for debugging analysis, then lets you play the analysis as speech in the browser.

## Pipeline

1. Friend sends `byteSize`, `hexData`, and optional `mimeType`.
2. Backend validates and reconstructs the image bytes.
3. Backend sends the reconstructed image to the AI model.
4. UI displays image + AI debugging output.
5. Browser Speech Synthesis reads the output aloud.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and set your key:
   ```env
   OPENAI_API_KEY=your_api_key_here
   OPENAI_VISION_MODEL=gpt-4.1-mini
   PORT=3000
   ```
3. Start server:
   ```bash
   npm run dev
   ```
4. Open:
   - `http://localhost:3000`

## Notes

- If `OPENAI_API_KEY` is missing, AI analysis is skipped with a message.
- Hex input can include spaces/new lines and `0x` prefixes.
- `byteSize` must exactly match reconstructed byte length.
- TTS uses browser-native Speech Synthesis (no extra API needed).
- UI includes a live "Received API Calls" section that auto-refreshes and shows calls from other clients too.

## API

### `POST /api/reconstruct-analyze`

Request JSON:

```json
{
  "byteSize": 68,
  "mimeType": "image/png",
  "hexData": "89504E47..."
}
```

### `GET /api/received-data?limit=15`

Returns recent captured API calls with caller metadata and full structured payloads.

Response JSON:

```json
{
   "items": [
      {
         "id": "evt_...",
         "statusCode": 200,
         "caller": {
            "ip": "::1",
            "userAgent": "Mozilla/..."
         },
         "payload": {
            "request": { "byteSize": 68, "mimeType": "image/png" },
            "reconstruction": { "success": true, "imageDataUrl": "data:image/png;base64,..." },
            "analysis": { "status": "completed", "text": "..." },
            "error": null,
            "meta": { "timestamp": "2026-03-22T10:20:30.000Z", "historyId": "evt_..." }
         }
      }
   ],
   "total": 1,
   "limit": 15,
   "maxHistoryItems": 40
}
```

Response JSON:

```json
{
   "request": {
      "byteSize": 68,
      "mimeType": "image/png"
   },
   "reconstruction": {
      "success": true,
      "imageDataUrl": "data:image/png;base64,...",
      "bytesReceived": 68,
      "mimeType": "image/png",
      "recovery": {
         "usedJpegMarkers": false
      }
   },
   "analysis": {
      "enabled": true,
      "model": "gpt-4.1-mini",
      "status": "completed",
      "text": "Detected likely syntax error near line..."
   },
   "error": null,
   "meta": {
      "timestamp": "2026-03-22T10:20:30.000Z"
   }
}
```
