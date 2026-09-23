/* ===================================================================
   Copilot Metrics Dashboard – Client Logic (Multi-Sheet Reports)
   =================================================================== */

(function () {
  'use strict';

  // --- DOM Elements ---
  const form = document.getElementById('metrics-form');
  const startDateInput = document.getElementById('start-date');
  const endDateInput = document.getElementById('end-date');
  const fetchBtn = document.getElementById('fetch-btn');
  const progressContainer = document.getElementById('progress-container');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');
  const summarySection = document.getElementById('summary-section');
  const summaryTotal = document.getElementById('summary-total');
  const summarySuccess = document.getElementById('summary-success');
  const summaryFailed = document.getElementById('summary-failed');
  const exportSection = document.getElementById('export-section');
  const exportCsvBtn = document.getElementById('export-csv-btn');
  const exportXlsxBtn = document.getElementById('export-xlsx-btn');
  const tableSection = document.getElementById('table-section');
  const tabsBar = document.getElementById('tabs-bar');
  const tableHead = document.getElementById('table-head');
  const tableBody = document.getElementById('table-body');
  const rowCount = document.getElementById('row-count');
  const errorToast = document.getElementById('error-toast');
  const errorText = document.getElementById('error-text');

  // State
  let currentSheets = {}; // { [sheetKey]: { label, columns, rows } }
  let activeSheetKey = null;
  let sortColumn = null;
  let sortDirection = 'asc';
  let toastTimer = null;

  // --- Utilities ---

  function showToast(message, durationMs = 6000) {
    errorText.textContent = message;
    errorToast.classList.remove('hidden');
    requestAnimationFrame(() => errorToast.classList.add('visible'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      errorToast.classList.remove('visible');
      setTimeout(() => errorToast.classList.add('hidden'), 300);
    }, durationMs);
  }

  function setLoading(loading) {
    if (loading) {
      fetchBtn.disabled = true;
      fetchBtn.querySelector('span').textContent = 'Fetching & Processing…';
      const svg = fetchBtn.querySelector('svg');
      if (svg) svg.style.display = 'none';
      let spinner = document.getElementById('btn-spinner');
      if (!spinner) {
        spinner = document.createElement('div');
        spinner.className = 'spinner';
        spinner.id = 'btn-spinner';
        fetchBtn.prepend(spinner);
      }
      progressContainer.classList.remove('hidden');
      progressFill.style.width = '0%';
      progressText.textContent = 'Calling GitHub Enterprise Metrics API…';
    } else {
      fetchBtn.disabled = false;
      fetchBtn.querySelector('span').textContent = 'Fetch Metrics';
      const svg = fetchBtn.querySelector('svg');
      if (svg) svg.style.display = '';
      const spinner = document.getElementById('btn-spinner');
      if (spinner) spinner.remove();
      progressContainer.classList.add('hidden');
    }
  }

  function countDays(start, end) {
    const s = new Date(start + 'T00:00:00Z');
    const e = new Date(end + 'T00:00:00Z');
    return Math.max(1, Math.round((e - s) / 86400000) + 1);
  }

  // --- Fetch Metrics ---

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const startDate = startDateInput.value;
    const endDate = endDateInput.value;

    if (!startDate || !endDate) {
      showToast('Please select both start and end dates.');
      return;
    }
    if (new Date(startDate) > new Date(endDate)) {
      showToast('Start date must be before or equal to end date.');
      return;
    }

    setLoading(true);

    const totalDays = countDays(startDate, endDate);
    let fakeProgress = 0;
    const progressInterval = setInterval(() => {
      fakeProgress = Math.min(fakeProgress + (85 / (totalDays * 2)), 90);
      progressFill.style.width = fakeProgress + '%';
      if (fakeProgress < 40) {
        progressText.textContent = `Requesting download links from GitHub (${Math.round(fakeProgress)}%)…`;
      } else {
        progressText.textContent = `Downloading & parsing report JSON metrics (${Math.round(fakeProgress)}%)…`;
      }
    }, 400);

    try {
      const response = await fetch('/api/metrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate, endDate }),
      });

      clearInterval(progressInterval);
      progressFill.style.width = '100%';
      progressText.textContent = 'Processing completed!';

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || `HTTP ${response.status}`);
      }

      const data = await response.json();
      currentSheets = data.sheets || {};

      // Update Summary Cards
      summaryTotal.textContent = data.summary?.total ?? 0;
      summarySuccess.textContent = data.summary?.success ?? 0;
      summaryFailed.textContent = data.summary?.failed ?? 0;
      summarySection.classList.remove('hidden');

      const sheetKeys = Object.keys(currentSheets);
      if (sheetKeys.length === 0) {
        tableSection.classList.add('hidden');
        exportSection.classList.add('hidden');
        showToast('No metrics data records returned for selected date range.');
        return;
      }

      // Render Tabs
      renderTabs(sheetKeys);

      // Select first tab by default or keep active if exists
      activeSheetKey = sheetKeys.includes(activeSheetKey) ? activeSheetKey : sheetKeys[0];
      switchTab(activeSheetKey);

      // Show sections
      tableSection.classList.remove('hidden');
      exportSection.classList.remove('hidden');

      if (data.errors && data.errors.length > 0) {
        showToast(`Completed with ${data.errors.length} failed day request(s). Check failed count.`);
      }
    } catch (err) {
      clearInterval(progressInterval);
      showToast(err.message || 'Failed to fetch metrics.');
    } finally {
      setTimeout(() => setLoading(false), 500);
    }
  });

  // --- Render Tabs ---

  function renderTabs(sheetKeys) {
    tabsBar.innerHTML = '';
    sheetKeys.forEach((key) => {
      const sheet = currentSheets[key];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab-btn' + (key === activeSheetKey ? ' active' : '');
      btn.dataset.sheetKey = key;

      const labelSpan = document.createElement('span');
      labelSpan.textContent = sheet.label || key;
      btn.appendChild(labelSpan);

      const countBadge = document.createElement('span');
      countBadge.className = 'tab-count';
      countBadge.textContent = sheet.rows?.length || 0;
      btn.appendChild(countBadge);

      btn.addEventListener('click', () => switchTab(key));
      tabsBar.appendChild(btn);
    });
  }

  function switchTab(sheetKey) {
    activeSheetKey = sheetKey;
    sortColumn = null;
    sortDirection = 'asc';

    // Update active tab button style
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.sheetKey === sheetKey);
    });

    const sheet = currentSheets[sheetKey];
    if (sheet) {
      renderTable(sheet.columns, sheet.rows);
    }
  }

  // --- Render Table ---

  function renderTable(columns, rows) {
    // Header
    tableHead.innerHTML = '';
    const headerRow = document.createElement('tr');
    columns.forEach((col) => {
      const th = document.createElement('th');
      th.textContent = col;
      th.dataset.column = col;

      const arrow = document.createElement('span');
      arrow.className = 'sort-arrow';
      arrow.textContent = ' ↕';
      th.appendChild(arrow);

      if (sortColumn === col) {
        th.classList.add(sortDirection === 'asc' ? 'sorted-asc' : 'sorted-desc');
        arrow.textContent = sortDirection === 'asc' ? ' ↑' : ' ↓';
      }

      th.addEventListener('click', () => handleSort(col));
      headerRow.appendChild(th);
    });
    tableHead.appendChild(headerRow);

    // Body
    tableBody.innerHTML = '';
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      columns.forEach((col) => {
        const td = document.createElement('td');
        const val = row[col];
        td.textContent = val !== undefined && val !== null ? String(val) : '';

        // Classify content for typography
        if (col === 'report_day') {
          td.classList.add('cell-date');
        } else if (typeof val === 'number') {
          td.classList.add('cell-number');
        } else if (typeof val === 'string' && val.length < 30) {
          td.classList.add('cell-string');
        }

        tr.appendChild(td);
      });
      tableBody.appendChild(tr);
    });

    rowCount.textContent = `${rows.length} row${rows.length !== 1 ? 's' : ''}`;
  }

  // --- Sorting ---

  function handleSort(column) {
    if (!activeSheetKey || !currentSheets[activeSheetKey]) return;
    const sheet = currentSheets[activeSheetKey];

    if (sortColumn === column) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      sortColumn = column;
      sortDirection = 'asc';
    }

    const sortedRows = [...sheet.rows].sort((a, b) => {
      const va = a[column] ?? '';
      const vb = b[column] ?? '';

      const na = Number(va);
      const nb = Number(vb);
      if (!isNaN(na) && !isNaN(nb) && va !== '' && vb !== '') {
        return sortDirection === 'asc' ? na - nb : nb - na;
      }

      const cmp = String(va).localeCompare(String(vb), undefined, { numeric: true });
      return sortDirection === 'asc' ? cmp : -cmp;
    });

    renderTable(sheet.columns, sortedRows);
  }

  // --- Exports ---

  async function downloadFile(url, defaultFilename) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to download file.');
      }
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = defaultFilename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (err) {
      showToast(err.message || 'Download failed.');
    }
  }

  exportXlsxBtn.addEventListener('click', () => {
    if (!currentSheets || Object.keys(currentSheets).length === 0) {
      showToast('No data to export. Please fetch metrics first.');
      return;
    }
    downloadFile('/api/export?format=xlsx', 'copilot_metrics.xlsx');
  });

  exportCsvBtn.addEventListener('click', () => {
    if (!activeSheetKey || !currentSheets[activeSheetKey]) {
      showToast('No active tab data to export. Please fetch metrics first.');
      return;
    }
    downloadFile(`/api/export?format=csv&sheet=${encodeURIComponent(activeSheetKey)}`, `copilot_metrics_${activeSheetKey}.csv`);
  });

})();
