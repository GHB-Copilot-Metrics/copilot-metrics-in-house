require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const XLSX = require('xlsx');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const GITHUB_PAT = process.env.GITHUB_PAT;
const API_BASE = 'https://api.github.com/enterprises/BALICteam/copilot/metrics/reports/enterprise-1-day';

// In-memory store for the last fetched dataset (used by /api/export)
let lastFetchedResult = null;

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/** Generate array of date strings (YYYY-MM-DD) between start and end (inclusive). */
function getDateRange(startDate, endDate) {
  const dates = [];
  const current = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  while (current <= end) {
    dates.push(current.toISOString().split('T')[0]);
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Given the raw metrics JSON for a single day, extract structured sheets.
 * Returns an object with arrays for each sheet type.
 */
function extractSheets(dayJson, reportDay) {
  const result = {
    summary: [],
    byLanguageFeature: [],
    byLanguageModel: [],
    byModelFeature: [],
    byAiAdoptionPhase: [],
    pullRequests: [],
  };

  // --- Summary (top-level scalar fields) ---
  const summaryRow = { report_day: reportDay };
  const skipKeys = new Set([
    'totals_by_language_feature',
    'totals_by_language_model',
    'totals_by_model_feature',
    'totals_by_ai_adoption_phase',
    'pull_requests',
  ]);
  for (const [key, value] of Object.entries(dayJson)) {
    if (skipKeys.has(key)) continue;
    if (typeof value === 'object' && value !== null) continue;
    summaryRow[key] = value;
  }
  result.summary.push(summaryRow);

  // --- Pull Requests ---
  if (dayJson.pull_requests && typeof dayJson.pull_requests === 'object') {
    const prRow = { report_day: reportDay };
    for (const [key, value] of Object.entries(dayJson.pull_requests)) {
      if (Array.isArray(value)) {
        prRow[key] = JSON.stringify(value);
      } else {
        prRow[key] = value;
      }
    }
    result.pullRequests.push(prRow);
  }

  // --- Totals by Language + Feature ---
  if (Array.isArray(dayJson.totals_by_language_feature)) {
    for (const item of dayJson.totals_by_language_feature) {
      result.byLanguageFeature.push({ report_day: reportDay, ...item });
    }
  }

  // --- Totals by Language + Model ---
  if (Array.isArray(dayJson.totals_by_language_model)) {
    for (const item of dayJson.totals_by_language_model) {
      result.byLanguageModel.push({ report_day: reportDay, ...item });
    }
  }

  // --- Totals by Model + Feature ---
  if (Array.isArray(dayJson.totals_by_model_feature)) {
    for (const item of dayJson.totals_by_model_feature) {
      result.byModelFeature.push({ report_day: reportDay, ...item });
    }
  }

  // --- Totals by AI Adoption Phase ---
  if (Array.isArray(dayJson.totals_by_ai_adoption_phase)) {
    for (const item of dayJson.totals_by_ai_adoption_phase) {
      result.byAiAdoptionPhase.push({ report_day: reportDay, ...item });
    }
  }

  return result;
}

/** Merge multiple sheet-result objects into one aggregated object. */
function mergeSheets(allResults) {
  const merged = {
    summary: [],
    byLanguageFeature: [],
    byLanguageModel: [],
    byModelFeature: [],
    byAiAdoptionPhase: [],
    pullRequests: [],
  };
  for (const r of allResults) {
    merged.summary.push(...r.summary);
    merged.byLanguageFeature.push(...r.byLanguageFeature);
    merged.byLanguageModel.push(...r.byLanguageModel);
    merged.byModelFeature.push(...r.byModelFeature);
    merged.byAiAdoptionPhase.push(...r.byAiAdoptionPhase);
    merged.pullRequests.push(...r.pullRequests);
  }
  return merged;
}

/** Collect all unique column names from an array of objects, keeping report_day first. */
function getColumns(rows) {
  const colSet = new Set();
  rows.forEach((r) => Object.keys(r).forEach((k) => colSet.add(k)));
  const cols = ['report_day', ...Array.from(colSet).filter((c) => c !== 'report_day').sort()];
  return cols;
}

// ─────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/metrics
 * Body: { startDate: "YYYY-MM-DD", endDate: "YYYY-MM-DD" }
 *
 * Two-step fetch per day:
 *   1. Call GitHub API → get download_links
 *   2. Fetch each download link → get actual JSON metrics
 * Flatten nested arrays into separate sheets, aggregate across days.
 */
app.post('/api/metrics', async (req, res) => {
  const { startDate, endDate } = req.body;

  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'startDate and endDate are required.' });
  }
  if (new Date(startDate) > new Date(endDate)) {
    return res.status(400).json({ error: 'startDate must be before or equal to endDate.' });
  }

  const dates = getDateRange(startDate, endDate);
  const allSheets = [];
  const errors = [];

  const BATCH_SIZE = 10;
  for (let i = 0; i < dates.length; i += BATCH_SIZE) {
    const batch = dates.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (day) => {
        const daySheets = [];
        const dayErrors = [];
        try {
          const apiResp = await axios.get(`${API_BASE}?day=${day}`, {
            headers: {
              Authorization: `token ${GITHUB_PAT}`,
              Accept: 'application/json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
            timeout: 30000,
          });

          const { download_links, report_day } = apiResp.data;
          const reportDay = report_day || day;

          if (!download_links || download_links.length === 0) {
            dayErrors.push({ day, status: 'NO_LINKS', message: 'No download links returned.' });
            return { sheets: daySheets, errors: dayErrors };
          }

          for (const link of download_links) {
            try {
              const dlResp = await axios.get(link, { timeout: 60000, responseType: 'text' });
              const rawText = typeof dlResp.data === 'string' ? dlResp.data : JSON.stringify(dlResp.data);
              const lines = rawText.trim().split('\n');
              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const parsed = JSON.parse(line);
                  daySheets.push(extractSheets(parsed, reportDay));
                } catch (parseErr) {
                  dayErrors.push({ day, status: 'PARSE_ERROR', message: `Failed to parse line: ${parseErr.message}` });
                }
              }
            } catch (dlErr) {
              const status = dlErr.response?.status || 'NETWORK';
              dayErrors.push({ day, status, message: `Download link error: ${dlErr.message}` });
            }
          }
        } catch (err) {
          const status = err.response?.status || 'NETWORK';
          const message = err.response?.data?.message || err.message;
          dayErrors.push({ day, status, message });
        }
        return { sheets: daySheets, errors: dayErrors };
      })
    );

    for (const res of batchResults) {
      if (res.sheets) allSheets.push(...res.sheets);
      if (res.errors) errors.push(...res.errors);
    }
  }

  // Merge all daily sheets
  const merged = mergeSheets(allSheets);

  // Build response with columns for each sheet
  const sheetsWithColumns = {};
  const sheetMeta = [
    { key: 'summary', label: 'Daily Summary' },
    { key: 'byLanguageFeature', label: 'By Language & Feature' },
    { key: 'byLanguageModel', label: 'By Language & Model' },
    { key: 'byModelFeature', label: 'By Model & Feature' },
    { key: 'byAiAdoptionPhase', label: 'By AI Adoption Phase' },
    { key: 'pullRequests', label: 'Pull Requests' },
  ];

  for (const { key, label } of sheetMeta) {
    const rows = merged[key];
    if (rows.length > 0) {
      sheetsWithColumns[key] = {
        label,
        columns: getColumns(rows),
        rows,
      };
    }
  }

  lastFetchedResult = { sheets: sheetsWithColumns, sheetMeta };

  res.json({
    sheets: sheetsWithColumns,
    summary: {
      total: dates.length,
      success: dates.length - errors.length,
      failed: errors.length,
    },
    errors,
  });
});

/**
 * GET /api/export?format=csv|xlsx&sheet=<sheetKey>
 *
 * - xlsx: exports ALL sheets as separate tabs in one Excel workbook
 * - csv: exports a single sheet (specified by ?sheet=summary)
 */
app.get('/api/export', (req, res) => {
  const format = (req.query.format || 'csv').toLowerCase();
  const sheetKey = req.query.sheet || 'summary';

  if (!lastFetchedResult || !lastFetchedResult.sheets) {
    return res.status(400).json({ error: 'No data to export. Fetch metrics first.' });
  }

  const { sheets } = lastFetchedResult;
  const wb = XLSX.utils.book_new();

  if (format === 'xlsx') {
    // Export all sheets into one workbook
    for (const [key, sheetData] of Object.entries(sheets)) {
      const ws = XLSX.utils.json_to_sheet(sheetData.rows, { header: sheetData.columns });
      // Excel sheet name max 31 chars
      const name = sheetData.label.substring(0, 31);
      XLSX.utils.book_append_sheet(wb, ws, name);
    }
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.attachment('copilot_metrics.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.end(buffer);
  }

  // CSV: export a single sheet
  const sheetData = sheets[sheetKey];
  if (!sheetData) {
    return res.status(400).json({ error: `Sheet "${sheetKey}" not found. Available: ${Object.keys(sheets).join(', ')}` });
  }
  const ws = XLSX.utils.json_to_sheet(sheetData.rows, { header: sheetData.columns });
  const csv = XLSX.utils.sheet_to_csv(ws);
  res.attachment(`copilot_metrics_${sheetKey}.csv`);
  res.setHeader('Content-Type', 'text/csv');
  return res.send(csv);
});

const server = app.listen(PORT, () => {
  console.log(`🚀 Copilot Metrics Dashboard running at http://localhost:${PORT}`);
});
server.setTimeout(300000); // 5 minutes timeout for large date ranges
