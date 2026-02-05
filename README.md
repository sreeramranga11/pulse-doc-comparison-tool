# Pulse Document Comparison Tool

A modern web interface for comparing two document versions using the Pulse API. Upload
any Pulse-supported file type (PDF, Word, images, etc.), extract structured content, and
review differences side-by-side with highlighted changes.

## Approach
- **Single-page UI** in plain HTML/CSS/JS for fast iteration and easy deployment.
- **Node/Express API** powered by the official Pulse SDK for secure API calls and diff generation.
- **Word and line diffing** using the `diff` library to highlight additions/removals.
- **Optional structured extraction** using Pulse `structured_output` schemas for field-level diffs.
- **Optional AI insights** via OpenAI (server-side) to summarize changes and suggest reviewer checks.
- **Async extraction + polling** for large documents.
- **Debug logs in terminal only** (toggle with `PULSE_DEBUG_LOGS`).

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
   # Automatically switches to async when either upload is >= this threshold
   PULSE_LARGE_FILE_THRESHOLD_MB=10
   ```
4. (Optional) Enable AI-powered insights (recommended):
   ```bash
   OPENAI_API_KEY=your_openai_key_here
   # Optional:
   OPENAI_MODEL=gpt-4o-mini
   ```
5. Start the server:
   ```bash
   npm start
   ```
6. Open `http://localhost:3000`.

## Usage
1. Upload **Document A** and **Document B**.
2. Click **Compare Documents**.
3. Review:
   - **Summary stats** (words/lines added, words/lines removed, diff chunks)
   - **Insights** (AI-generated) for quick change scanning
   - **Side-by-side view** for easy change scanning
   - **Inline diff** for a combined view
   - **Extracted text** to validate Pulse output
   - **Structured output (optional)** for field-level extraction + diffing

## Design decisions & tradeoffs
- **Server-side extraction & diffing** keeps API keys private and allows clean error
  handling.
- **Polling support** keeps large-file extraction responsive.
- **Auto async threshold:** The default `PULSE_LARGE_FILE_THRESHOLD_MB=10` is a practical rule-of-thumb (and what Pulse’s API assistant suggested as an “industry standard” cutoff) for switching to async when files get big; it also matches Pulse docs/examples that recommend direct upload for files under 10MB.
- **Text diff is content-first** (word/line) and may not reflect layout-only changes.
  For layout-aware comparisons, use structured extraction and field-level diffs.

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
- Visual PDF diff overlays for precise layout comparison.
- Deeper change categorization (formatting vs semantic changes).
- Exportable diff reports (PDF/CSV).

## Troubleshooting
- Ensure `PULSE_API_KEY` is set.
- If your Pulse account uses different routes, update `PULSE_BASE_URL`.
- Disable debug logs via `PULSE_DEBUG_LOGS=false`.
