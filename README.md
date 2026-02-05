# Pulse Document Comparison Tool

A modern web interface for comparing two document versions using the Pulse API. Upload
any Pulse-supported file type (PDF, Word, images, etc.), extract structured content, and
review differences side-by-side with highlighted changes.

## Approach
- **Single-page UI** in plain HTML/CSS/JS for fast iteration and easy deployment.
- **Node/Express API** powered by the official Pulse SDK for secure API calls and diff generation.
- **Word-level diffing** using the `diff` library to highlight additions/removals.
- **Debug-first workflow** with server/client logs enabled by default and easy toggles.

## Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file in the repo root:
   ```bash
   PULSE_API_KEY=your_key_here
   ```
3. (Optional) Override Pulse endpoints or behavior:
   ```bash
   PULSE_BASE_URL=https://api.runpulse.com
   PULSE_DEBUG_LOGS=true
   PULSE_USE_ASYNC=true
   ```
4. Start the server:
   ```bash
   npm start
   ```
5. Open `http://localhost:3000`.

## Usage
1. Upload **Document A** and **Document B**.
2. Click **Compare Documents**.
3. Review:
   - **Summary stats** (insertions, removals, total diff parts)
   - **Side-by-side view** for easy change scanning
   - **Inline diff** for a combined view
   - **Extracted text** to validate Pulse output
   - **Debug logs** for API request/response details

## Design decisions & tradeoffs
- **Server-side extraction & diffing** keeps API keys private and allows clean error
  handling.
- **Configurable Pulse endpoints** because API routes can vary by plan/version.
- **Polling support** handles async extraction workflows while keeping the UI responsive.
- **Simple word-level diff** is fast and readable, but may not capture deeper structural
  changes. This keeps performance predictable for large documents.

## Example output
```
Summary
- Insertions: 14
- Removals: 9
- Diff Parts: 87

Sample inline diff
The agreement becomes <added>effective on March 1st</added> and
<removed>effective on February 15th</removed>.
```

## What I’d improve with more time
- Schema-based extraction for field-level diffs.
- Visual PDF diff overlays for precise layout comparison.
- Async job queue for very large documents.
- Change categorization (formatting vs. semantic changes).
- Exportable diff reports (PDF/CSV).

## Troubleshooting
- Ensure `PULSE_API_KEY` is set.
- If your Pulse account uses different routes, update `PULSE_BASE_URL`.
- Disable debug logs via `PULSE_DEBUG_LOGS=false`.
