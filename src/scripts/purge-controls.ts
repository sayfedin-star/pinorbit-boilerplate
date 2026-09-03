const purgeConnEl = document.querySelector('[data-connection-id]');
const purgeConnId = purgeConnEl?.getAttribute('data-connection-id');
const purgeConnName = purgeConnEl?.getAttribute('data-display-name') || '';

if (purgeConnId) {
  const targetDailyCheckbox = document.getElementById('purge-target-daily') as HTMLInputElement | null;
  const targetTopPinsCheckbox = document.getElementById('purge-target-top-pins') as HTMLInputElement | null;
  const modeSingleRadio = document.getElementById('purge-mode-single') as HTMLInputElement | null;
  const modeRangeRadio = document.getElementById('purge-mode-range') as HTMLInputElement | null;
  const fromInput = document.getElementById('purge-from') as HTMLInputElement | null;
  const toInput = document.getElementById('purge-to') as HTMLInputElement | null;
  const toContainer = document.getElementById('purge-to-container');
  const previewBtn = document.getElementById('purge-preview-btn') as HTMLButtonElement | null;
  const previewCard = document.getElementById('purge-preview-card');
  const previewTbody = document.getElementById('purge-preview-tbody');
  const previewRollupsEl = document.getElementById('purge-preview-rollups');
  const previewTotalEl = document.getElementById('purge-preview-total');
  const confirmSection = document.getElementById('purge-confirm-section');
  const confirmInput = document.getElementById('purge-confirm-name') as HTMLInputElement | null;
  const deleteBtn = document.getElementById('purge-delete-btn') as HTMLButtonElement | null;
  const statusMsg = document.getElementById('purge-status-msg');

  let currentPreview: any = null;

  // Initialize today and default dates
  const todayStr = new Date().toISOString().split('T')[0];
  const defaultFrom = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

  if (fromInput && !fromInput.value) fromInput.value = defaultFrom;
  if (toInput && !toInput.value) toInput.value = todayStr;
  if (fromInput) fromInput.max = todayStr;
  if (toInput) toInput.max = todayStr;

  // Restore state from URL params if present
  const searchParams = new URLSearchParams(window.location.search);
  const pgFrom = searchParams.get('pg_from');
  const pgTo = searchParams.get('pg_to');
  const pgTargets = searchParams.get('pg_targets');

  if (pgFrom && fromInput) fromInput.value = pgFrom;
  if (pgTo && toInput) toInput.value = pgTo;
  if (pgTargets) {
    const list = pgTargets.split(',');
    if (targetDailyCheckbox) targetDailyCheckbox.checked = list.includes('daily');
    if (targetTopPinsCheckbox) targetTopPinsCheckbox.checked = list.includes('top_pins');
  }

  function getSelectedTargets(): string[] {
    const targets: string[] = [];
    if (targetDailyCheckbox?.checked) targets.push('daily');
    if (targetTopPinsCheckbox?.checked) targets.push('top_pins');
    return targets;
  }

  function updateUrlState() {
    const url = new URL(window.location.href);
    if (fromInput?.value) url.searchParams.set('pg_from', fromInput.value);
    if (toInput?.value) url.searchParams.set('pg_to', toInput.value);
    const targets = getSelectedTargets();
    if (targets.length > 0) {
      url.searchParams.set('pg_targets', targets.join(','));
    } else {
      url.searchParams.delete('pg_targets');
    }
    window.history.replaceState(null, '', url.toString());
  }

  // Handle single day vs range toggle
  modeSingleRadio?.addEventListener('change', () => {
    if (modeSingleRadio.checked) {
      if (toContainer) toContainer.classList.add('hidden');
      if (toInput && fromInput) toInput.value = fromInput.value;
      updateUrlState();
    }
  });

  modeRangeRadio?.addEventListener('change', () => {
    if (modeRangeRadio.checked) {
      if (toContainer) toContainer.classList.remove('hidden');
      updateUrlState();
    }
  });

  fromInput?.addEventListener('change', () => {
    if (modeSingleRadio?.checked && toInput && fromInput) {
      toInput.value = fromInput.value;
    }
    updateUrlState();
  });

  toInput?.addEventListener('change', updateUrlState);
  targetDailyCheckbox?.addEventListener('change', updateUrlState);
  targetTopPinsCheckbox?.addEventListener('change', updateUrlState);

  // Validate confirmation name input
  confirmInput?.addEventListener('input', () => {
    const entered = confirmInput.value.trim();
    if (deleteBtn) {
      deleteBtn.disabled = !currentPreview || entered !== purgeConnName.trim();
    }
  });

  async function safeFetchJson<T = any>(url: string, options?: RequestInit): Promise<T> {
    const res = await fetch(url, options);
    const contentType = res.headers.get('content-type') || '';

    if (!contentType.includes('application/json')) {
      const text = await res.text().catch(() => '');
      throw new Error(`Invalid server response (Content-Type: ${contentType || 'unknown'}). ${text.slice(0, 100)}`);
    }

    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      throw new Error(json.error || `Request failed with status HTTP ${res.status}`);
    }

    return json as T;
  }

  // Preview Button Handler
  previewBtn?.addEventListener('click', async () => {
    if (!fromInput || !toInput) return;
    const from = fromInput.value;
    const to = modeSingleRadio?.checked ? from : toInput.value;
    const targets = getSelectedTargets();

    if (statusMsg) {
      statusMsg.className = 'hidden';
      statusMsg.textContent = '';
    }

    if (!from || !to) {
      showStatus('Please select valid date values.', 'error');
      return;
    }

    if (from > to) {
      showStatus('From date cannot be after To date.', 'error');
      return;
    }

    if (targets.length === 0) {
      showStatus('Please select at least one target to purge (Daily Metrics or Top Pins).', 'error');
      return;
    }

    const spanDays = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000);
    if (spanDays > 90) {
      showStatus('Date range cannot exceed 90 days.', 'error');
      return;
    }

    if (previewBtn) {
      previewBtn.disabled = true;
      previewBtn.textContent = 'Calculating Preview...';
    }

    try {
      const json = await safeFetchJson(
        `/api/analytics/connections/${purgeConnId}/purge-preview?from=${from}&to=${to}&targets=${targets.join(',')}`
      );

      currentPreview = json.preview;
      renderPreview(json.preview);

      if (confirmSection) confirmSection.classList.remove('hidden');
      if (confirmInput) {
        confirmInput.value = '';
        confirmInput.focus();
      }
      if (deleteBtn) deleteBtn.disabled = true;

    } catch (err: any) {
      showStatus(err.message || 'Error generating preview.', 'error');
    } finally {
      if (previewBtn) {
        previewBtn.disabled = false;
        previewBtn.textContent = 'Preview Purge';
      }
    }
  });

  function renderPreview(preview: any) {
    if (!previewCard || !previewTbody) return;

    previewCard.classList.remove('hidden');

    previewTbody.innerHTML = `
      <tr class="border-b border-border/50">
        <td class="py-2.5 px-3 font-medium text-foreground">account_analytics_daily</td>
        <td class="py-2.5 px-3 text-right font-mono font-bold ${preview.daily_count > 0 ? 'text-amber-500' : 'text-muted-foreground'}">${preview.daily_count}</td>
      </tr>
      <tr class="border-b border-border/50">
        <td class="py-2.5 px-3 font-medium text-foreground">account_analytics_summaries</td>
        <td class="py-2.5 px-3 text-right font-mono font-bold ${preview.summaries_count > 0 ? 'text-amber-500' : 'text-muted-foreground'}">${preview.summaries_count}</td>
      </tr>
      <tr class="border-b border-border/50">
        <td class="py-2.5 px-3 font-medium text-foreground">top_pins_snapshots</td>
        <td class="py-2.5 px-3 text-right font-mono font-bold ${preview.top_pins_count > 0 ? 'text-amber-500' : 'text-muted-foreground'}">${preview.top_pins_count}</td>
      </tr>
    `;

    if (previewTotalEl) {
      previewTotalEl.textContent = `${preview.total_records} records total`;
    }

    if (previewRollupsEl) {
      const dates = preview.affected_rollup_dates || [];
      if (dates.length > 0) {
        previewRollupsEl.innerHTML = `<span class="font-semibold text-foreground">Affected Workspace Rollup Dates (${dates.length}):</span> <span class="font-mono text-muted-foreground">${dates.join(', ')}</span>`;
      } else {
        previewRollupsEl.innerHTML = `<span class="text-muted-foreground">No existing daily_workspace_metrics rollups in selected range.</span>`;
      }
    }
  }

  // Delete Permanently Button Handler
  deleteBtn?.addEventListener('click', async () => {
    if (!currentPreview || !fromInput || !toInput || !confirmInput) return;

    const from = fromInput.value;
    const to = modeSingleRadio?.checked ? from : toInput.value;
    const targets = getSelectedTargets();
    const confirmName = confirmInput.value.trim();

    if (confirmName !== purgeConnName.trim()) {
      showStatus(`Please type exactly "${purgeConnName}" to confirm deletion.`, 'error');
      return;
    }

    if (!confirm(`Are you absolutely sure you want to permanently delete these ${currentPreview.total_records} records? This action cannot be undone.`)) {
      return;
    }

    deleteBtn.disabled = true;
    deleteBtn.textContent = 'Purging Data...';

    try {
      const json = await safeFetchJson(`/api/analytics/connections/${purgeConnId}/purge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_date: from,
          to_date: to,
          targets,
          confirm_name: confirmName,
        }),
      });

      const c = json.counts || {};
      const totalDeleted = (c.daily_deleted || 0) + (c.summaries_deleted || 0) + (c.top_pins_deleted || 0);

      showStatus(
        `✓ Data Purged Successfully! Deleted ${totalDeleted} records (${c.daily_deleted || 0} daily, ${c.top_pins_deleted || 0} top pins, ${c.summaries_deleted || 0} summaries). Rebuilt ${c.rollups_rebuilt || 0} rollup dates. (Audit Log ID: ${json.purge_log_id || 'recorded'})`,
        'success'
      );

      // Reset state
      currentPreview = null;
      if (previewCard) previewCard.classList.add('hidden');
      if (confirmSection) confirmSection.classList.add('hidden');
      if (confirmInput) confirmInput.value = '';

      // Notify analytics tables and pin intelligence to reload
      window.dispatchEvent(new CustomEvent('analytics:data-purged'));

    } catch (err: any) {
      showStatus(err.message || 'Purge execution failed.', 'error');
    } finally {
      if (deleteBtn) {
        deleteBtn.disabled = false;
        deleteBtn.textContent = 'Delete Permanently';
      }
    }
  });

  function showStatus(msg: string, type: 'error' | 'success') {
    if (!statusMsg) return;
    statusMsg.classList.remove('hidden', 'bg-destructive/10', 'text-destructive', 'border-destructive/30', 'bg-emerald-500/10', 'text-emerald-600', 'dark:text-emerald-400', 'border-emerald-500/30');
    if (type === 'error') {
      statusMsg.className = 'rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs font-semibold text-destructive';
    } else {
      statusMsg.className = 'rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs font-semibold text-emerald-600 dark:text-emerald-400';
    }
    statusMsg.textContent = msg;
  }
}
