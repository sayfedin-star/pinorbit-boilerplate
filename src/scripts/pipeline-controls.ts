const pipelineConnectionEl = document.querySelector('[data-connection-id]');
const pipeConnId = pipelineConnectionEl?.getAttribute('data-connection-id');

const escapeHtml = (s: any) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m] as string));

const humanizeCron = (expr: string, tz: string) => {
  const m = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec((expr || '').trim());
  return m ? `Daily at ${String(m[2]).padStart(2, '0')}:${String(m[1]).padStart(2, '0')} ${tz}` : (expr || '—');
};

const relativeTime = (iso?: string | null) => {
  if (!iso) return '—';
  const diffMs = Date.now() - new Date(iso).getTime();
  if (isNaN(diffMs)) return '—';
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
};

function showInlineError(target: HTMLElement, message: string) {
  let errEl = target.querySelector('.inline-error');
  if (!errEl) {
    errEl = document.createElement('div');
    errEl.className = 'inline-error mt-4 rounded-md bg-red-500/10 p-3 text-sm text-red-500 border border-red-500/20';
    target.appendChild(errEl);
  }
  errEl.textContent = message;
  setTimeout(() => errEl?.remove(), 6000);
}

function showToast(message: string, isSuccess = true) {
  let toast = document.getElementById('pipeline-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'pipeline-toast';
    toast.className = 'fixed bottom-5 right-5 z-50 rounded-xl px-4 py-3 text-xs font-semibold shadow-lg transition-all transform';
    document.body.appendChild(toast);
  }
  toast.className = isSuccess
    ? 'fixed bottom-5 right-5 z-50 rounded-xl bg-emerald-600 text-white px-4 py-3 text-xs font-semibold shadow-lg border border-emerald-500/30'
    : 'fixed bottom-5 right-5 z-50 rounded-xl bg-red-600 text-white px-4 py-3 text-xs font-semibold shadow-lg border border-red-500/30';
  toast.textContent = message;
  toast.style.display = 'block';
  setTimeout(() => {
    if (toast) toast.style.display = 'none';
  }, 4000);
}

if (pipeConnId) {
  // Fetch settings for Tab 2
  async function loadPipelineSettings() {
    try {
      const res = await fetch(`/api/analytics/connections/${pipeConnId}/settings`);
      const contentType = res.headers.get('content-type');
      if (!res.ok) {
        let msg = 'Failed to load';
        try {
          if (contentType?.includes('application/json')) {
            const err = await res.json();
            msg = err.error || msg;
          } else {
            msg = await res.text();
          }
        } catch (parseErr) {
          msg = `HTTP ${res.status} (unparseable error body: ${parseErr instanceof Error ? parseErr.message : 'unknown'})`;
        }
        throw new Error(`HTTP ${res.status}: ${msg}`);
      }
      const { data } = await res.json();
      
      const lastSyncEl = document.getElementById('connection-last-sync');
      if (lastSyncEl) {
        lastSyncEl.textContent = data.last_analytics_sync_at 
          ? `${new Date(data.last_analytics_sync_at).toLocaleString()} (${relativeTime(data.last_analytics_sync_at)})`
          : '—';
      }

      const pA = document.querySelector('[data-pipeline="analytics"]');
      if (pA) {
        (pA.querySelector('[data-field="webhook_url"]') as HTMLInputElement).value = data.analytics_webhook_url || '';
        (pA.querySelector('[data-field="sync_time"]') as HTMLInputElement).value = data.analytics_sync_time || '';
        (pA.querySelector('[data-field="start_offset"]') as HTMLInputElement).value = data.analytics_start_offset_days ?? 7;
        (pA.querySelector('[data-field="end_offset"]') as HTMLInputElement).value = data.analytics_end_offset_days ?? 1;
        const chipA = pA.querySelector('[data-chip]');
        if (chipA) chipA.textContent = data.analytics_schedule_status || 'pending';
        
        const badgeA = pA.querySelector('[data-token-badge]');
        if (badgeA) {
          const fingerprintA = data.analytics_token_fingerprint || data.analytics_fastcron_token_fingerprint;
          badgeA.textContent = (data.has_analytics_fastcron_token && fingerprintA)
            ? `Custom: ${fingerprintA}` 
            : 'Workspace Default';
        }

        const errMsgA = pA.querySelector('[data-err-msg]') as HTMLElement;
        if (errMsgA) {
          if (data.analytics_schedule_status === 'error' && data.last_error_a) {
            errMsgA.textContent = data.last_error_a;
            errMsgA.title = data.last_error_a;
            errMsgA.classList.remove('hidden');
          } else {
            errMsgA.classList.add('hidden');
          }
        }
      }
      
      const pB = document.querySelector('[data-pipeline="top_pins"]');
      if (pB) {
        (pB.querySelector('[data-field="webhook_url"]') as HTMLInputElement).value = data.top_pins_webhook_url || '';
        (pB.querySelector('[data-field="sync_time"]') as HTMLInputElement).value = data.top_pins_sync_time || '';
        (pB.querySelector('[data-field="start_offset"]') as HTMLInputElement).value = data.top_pins_start_offset_days ?? 7;
        (pB.querySelector('[data-field="end_offset"]') as HTMLInputElement).value = data.top_pins_end_offset_days ?? 2;
        (pB.querySelector('[data-field="num_of_pins"]') as HTMLInputElement).value = data.top_pins_num_of_pins ?? 50;
        const chipB = pB.querySelector('[data-chip]');
        if (chipB) chipB.textContent = data.top_pins_schedule_status || 'pending';

        const badgeB = pB.querySelector('[data-token-badge]');
        if (badgeB) {
          const fingerprintB = data.top_pins_token_fingerprint || data.top_pins_fastcron_token_fingerprint;
          badgeB.textContent = (data.has_top_pins_fastcron_token && fingerprintB)
            ? `Custom: ${fingerprintB}` 
            : 'Workspace Default';
        }

        const errMsgB = pB.querySelector('[data-err-msg]') as HTMLElement;
        if (errMsgB) {
          if (data.top_pins_schedule_status === 'error' && data.last_error_b) {
            errMsgB.textContent = data.last_error_b;
            errMsgB.title = data.last_error_b;
            errMsgB.classList.remove('hidden');
          } else {
            errMsgB.classList.add('hidden');
          }
        }
        
        // Sort modes
        const modes = data.top_pins_sort_modes || [];
        pB.querySelectorAll('[data-mode]').forEach(b => {
          const m = b.getAttribute('data-mode')!;
          if (modes.includes(m)) {
            b.setAttribute('aria-pressed', 'true');
            b.className = 'rounded-lg border border-primary/40 bg-primary/10 px-2.5 py-1 text-[10px] font-bold text-primary';
          } else {
            b.setAttribute('aria-pressed', 'false');
            b.className = 'rounded-lg border border-border bg-card px-2.5 py-1 text-[10px] font-bold text-muted-foreground hover:bg-muted';
          }
        });
      }
      
      const fc = document.getElementById('fastcron-options-card');
      if (fc) {
        const notifyEl = fc.querySelector('[data-field="fastcron_notify"]') as HTMLInputElement;
        if (notifyEl) notifyEl.checked = data.fastcron_notify ?? true;
        const timeoutEl = fc.querySelector('[data-field="fastcron_timeout"]') as HTMLInputElement;
        if (timeoutEl) timeoutEl.value = String(data.fastcron_timeout ?? 30);
        const instancesEl = fc.querySelector('[data-field="fastcron_instances"]') as HTMLInputElement;
        if (instancesEl) instancesEl.value = String(data.fastcron_instances ?? 1);
      }
      
      // Update health banner
      const healthChip = document.getElementById('health-status-chip');
      const totalRunsEl = document.getElementById('health-total-runs');
      const consecFailEl = document.getElementById('health-consecutive-failures');
      const lastSuccessEl = document.getElementById('health-last-success');

      if (data.health) {
        if (totalRunsEl) totalRunsEl.textContent = String(data.health.total_runs ?? 0);
        if (consecFailEl) consecFailEl.textContent = String(data.health.consecutive_failures ?? 0);
        if (lastSuccessEl) {
          lastSuccessEl.textContent = data.health.last_success_at
            ? new Date(data.health.last_success_at).toLocaleString()
            : '—';
        }
        if (healthChip) {
          const fails = data.health.consecutive_failures ?? 0;
          const isRevoked = data.health.revoked || fails >= 3;
          if (isRevoked) {
            healthChip.textContent = 'Revoked';
            healthChip.className = 'rounded-full px-3 py-1 text-xs font-bold bg-red-500/10 text-red-500 shadow-sm border border-red-500/20';
          } else if (fails === 2) {
            healthChip.textContent = 'Critical';
            healthChip.className = 'rounded-full px-3 py-1 text-xs font-bold bg-rose-500/10 text-rose-500 shadow-sm border border-rose-500/20';
          } else if (fails === 1) {
            healthChip.textContent = 'Warning';
            healthChip.className = 'rounded-full px-3 py-1 text-xs font-bold bg-amber-500/10 text-amber-500 shadow-sm border border-amber-500/20';
          } else {
            healthChip.textContent = 'Healthy';
            healthChip.className = 'rounded-full px-3 py-1 text-xs font-bold bg-emerald-500/10 text-emerald-500 shadow-sm border border-emerald-500/20';
          }
        }
      }
      
    } catch (e: any) {
      console.error('Failed to load settings', e);
      const container = document.getElementById('pipeline-settings-container') || document.getElementById('panel-pipe');
      if (container) showInlineError(container, e.message);
      
      const lastSyncEl = document.getElementById('connection-last-sync');
      if (lastSyncEl) lastSyncEl.textContent = '—';
      const healthChip = document.getElementById('health-status-chip');
      if (healthChip) {
        healthChip.textContent = '—';
        healthChip.className = 'rounded-full px-3 py-1 text-xs font-bold bg-muted text-muted-foreground shadow-sm';
      }
      const totalRunsEl = document.getElementById('health-total-runs');
      if (totalRunsEl) totalRunsEl.textContent = '—';
      const consecFailEl = document.getElementById('health-consecutive-failures');
      if (consecFailEl) consecFailEl.textContent = '—';
      const lastSuccessEl = document.getElementById('health-last-success');
      if (lastSuccessEl) lastSuccessEl.textContent = '—';
    }
  }

  // Update bulk actions bar state
  function getSelectedJobIds(): number[] {
    const checked = document.querySelectorAll('.cron-job-checkbox:checked') as NodeListOf<HTMLInputElement>;
    const ids: number[] = [];
    checked.forEach((c) => {
      const id = Number(c.getAttribute('data-job-id'));
      if (!isNaN(id) && id > 0) ids.push(id);
    });
    return ids;
  }

  function updateBulkBar() {
    const bulkBar = document.getElementById('cron-bulk-bar');
    const countEl = document.getElementById('cron-selected-count');
    const selectAll = document.getElementById('cron-select-all') as HTMLInputElement;
    const allBoxes = document.querySelectorAll('.cron-job-checkbox') as NodeListOf<HTMLInputElement>;
    const checkedBoxes = document.querySelectorAll('.cron-job-checkbox:checked') as NodeListOf<HTMLInputElement>;

    const count = checkedBoxes.length;
    if (countEl) countEl.textContent = String(count);

    if (bulkBar) {
      if (count > 0) {
        bulkBar.classList.remove('hidden');
      } else {
        bulkBar.classList.add('hidden');
      }
    }

    if (selectAll && allBoxes.length > 0) {
      if (count === 0) {
        selectAll.checked = false;
        selectAll.indeterminate = false;
      } else if (count === allBoxes.length) {
        selectAll.checked = true;
        selectAll.indeterminate = false;
      } else {
        selectAll.checked = false;
        selectAll.indeterminate = true;
      }
    }
  }

  // Generic Cron Action Modal helpers
  function showCronModal(options: {
    title: string;
    bodyNode: HTMLElement;
    confirmLabel?: string;
    confirmClass?: string;
    showCancel?: boolean;
    onConfirm?: () => Promise<void>;
  }) {
    const backdrop = document.getElementById('cron-modal-backdrop');
    const titleEl = document.getElementById('cron-modal-title');
    const bodyEl = document.getElementById('cron-modal-body');
    const submitBtn = document.getElementById('cron-modal-submit') as HTMLButtonElement;
    const cancelBtn = document.getElementById('cron-modal-cancel') as HTMLButtonElement;
    if (!backdrop || !titleEl || !bodyEl || !submitBtn) return;

    titleEl.textContent = options.title;
    bodyEl.innerHTML = '';
    bodyEl.appendChild(options.bodyNode);

    submitBtn.textContent = options.confirmLabel || 'Confirm';
    submitBtn.className = options.confirmClass || 'rounded-xl bg-primary px-4 py-2 text-xs font-bold text-primary-foreground hover:bg-primary/90';
    submitBtn.onclick = async () => {
      if (options.onConfirm) {
        submitBtn.setAttribute('disabled', 'true');
        const orig = submitBtn.textContent;
        submitBtn.textContent = 'Processing...';
        try {
          await options.onConfirm();
          hideCronModal();
        } catch (err: any) {
          showToast(err.message || 'Action failed', false);
        } finally {
          submitBtn.removeAttribute('disabled');
          submitBtn.textContent = orig;
        }
      } else {
        hideCronModal();
      }
    };

    if (cancelBtn) {
      if (options.showCancel === false) {
        cancelBtn.classList.add('hidden');
      } else {
        cancelBtn.classList.remove('hidden');
      }
    }

    backdrop.classList.remove('hidden');
    backdrop.classList.add('flex');
  }

  function hideCronModal() {
    const backdrop = document.getElementById('cron-modal-backdrop');
    if (backdrop) {
      backdrop.classList.add('hidden');
      backdrop.classList.remove('flex');
    }
  }

  const modalCloseBtn = document.getElementById('cron-modal-close');
  if (modalCloseBtn) modalCloseBtn.onclick = hideCronModal;
  const modalCancelBtn = document.getElementById('cron-modal-cancel');
  if (modalCancelBtn) modalCancelBtn.onclick = hideCronModal;

  // Load Cron Jobs table
  async function loadCronJobs() {
    const tbody = document.getElementById('cron-jobs-rows');
    if (!tbody || !pipeConnId) return;

    // Render skeleton pulse rows while fetching
    tbody.innerHTML = '';
    for (let i = 0; i < 2; i++) {
      const tr = document.createElement('tr');
      tr.className = 'border-b border-slate-100 dark:border-border/50 animate-pulse';
      const td = document.createElement('td');
      td.colSpan = 7;
      td.className = 'py-4 pr-4';
      const bar = document.createElement('div');
      bar.className = 'h-4 bg-slate-200 dark:bg-muted rounded w-3/4';
      td.appendChild(bar);
      tr.appendChild(td);
      tbody.appendChild(tr);
    }

    try {
      const res = await fetch(`/api/analytics/connections/${pipeConnId}/cron-jobs`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!data.success || !Array.isArray(data.pipelines)) {
        throw new Error(data.error || 'Invalid response from cron-jobs API');
      }

      tbody.innerHTML = '';
      const timezone = data.timezone || 'UTC';

      data.pipelines.forEach((p: any) => {
        const tr = document.createElement('tr');
        tr.className = 'border-b border-slate-100 hover:bg-slate-50/50 dark:border-border/50 dark:hover:bg-muted/20 transition-colors text-xs';

        // 0. Checkbox Column
        const tdCheckbox = document.createElement('td');
        tdCheckbox.className = 'py-3 pr-3 w-8';
        if (p.job_id) {
          const chk = document.createElement('input');
          chk.type = 'checkbox';
          chk.className = 'cron-job-checkbox rounded border-slate-300 text-primary focus:ring-primary h-4 w-4 cursor-pointer';
          chk.setAttribute('data-job-id', String(p.job_id));
          chk.setAttribute('data-channel', p.channel);
          chk.addEventListener('change', updateBulkBar);
          tdCheckbox.appendChild(chk);
        }
        tr.appendChild(tdCheckbox);

        // 1. Pipeline Column
        const tdPipeline = document.createElement('td');
        tdPipeline.className = 'py-3 pr-4 font-medium text-slate-800 dark:text-foreground';
        const labelDiv = document.createElement('div');
        labelDiv.className = 'font-semibold';
        labelDiv.textContent = p.label || (p.channel === 'account_analytics' ? 'Pipeline A: Account Analytics' : 'Pipeline B: Ranked Top Pins');
        const channelDiv = document.createElement('div');
        channelDiv.className = 'font-mono text-[11px] text-slate-400 dark:text-muted-foreground';
        channelDiv.textContent = p.channel === 'account_analytics' ? '/v5/user_account/analytics' : '/v5/user_account/analytics/top_pins';
        tdPipeline.appendChild(labelDiv);
        tdPipeline.appendChild(channelDiv);
        tr.appendChild(tdPipeline);

        // 2. Job Column
        const tdJob = document.createElement('td');
        tdJob.className = 'py-3 pr-4 font-mono text-slate-700 dark:text-foreground';
        if (p.job_id) {
          const code = document.createElement('span');
          code.className = 'inline-flex items-center px-1.5 py-0.5 rounded bg-slate-100 dark:bg-muted font-bold';
          code.textContent = `#${p.job_id}`;
          tdJob.appendChild(code);
        } else {
          tdJob.textContent = '—';
        }
        tr.appendChild(tdJob);

        // 3. Schedule Column
        const tdSchedule = document.createElement('td');
        tdSchedule.className = 'py-3 pr-4';
        const cronDiv = document.createElement('div');
        cronDiv.className = 'font-mono font-bold text-slate-800 dark:text-foreground';
        cronDiv.textContent = p.cron_expression || '—';
        const humanDiv = document.createElement('div');
        humanDiv.className = 'text-[11px] text-slate-500 dark:text-muted-foreground';
        humanDiv.textContent = humanizeCron(p.cron_expression, timezone);
        tdSchedule.appendChild(cronDiv);
        tdSchedule.appendChild(humanDiv);
        tr.appendChild(tdSchedule);

        // 4. Status Column
        const tdStatus = document.createElement('td');
        tdStatus.className = 'py-3 pr-4';
        const statusWrapper = document.createElement('div');
        statusWrapper.className = 'flex items-center gap-1.5 flex-wrap';

        const badge = document.createElement('span');
        const status = p.schedule_status || 'pending';
        if (status === 'synced') {
          badge.className = 'inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-bold text-emerald-600 dark:text-emerald-400';
          badge.textContent = 'synced';
        } else if (status === 'error') {
          badge.className = 'inline-flex items-center rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] font-bold text-red-500';
          badge.textContent = 'error';
        } else {
          badge.className = 'inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-bold text-amber-600 dark:text-amber-400';
          badge.textContent = 'pending';
        }
        statusWrapper.appendChild(badge);

        if (p.live_status) {
          const liveChip = document.createElement('span');
          liveChip.className = 'inline-flex items-center rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-bold text-blue-600 dark:text-blue-400';
          liveChip.textContent = String(p.live_status);
          statusWrapper.appendChild(liveChip);
        }
        tdStatus.appendChild(statusWrapper);
        tr.appendChild(tdStatus);

        // 5. Last Runs Column (Sparkline 10 cells)
        const tdRuns = document.createElement('td');
        tdRuns.className = 'py-3 pr-4';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 116 14');
        svg.setAttribute('class', 'w-28 h-3.5 inline-block align-middle');
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', 'Last 10 runs status');

        const runs = Array.isArray(p.last_runs) ? p.last_runs : [];
        for (let cellIdx = 0; cellIdx < 10; cellIdx++) {
          const run = runs[cellIdx];
          const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          rect.setAttribute('x', String(cellIdx * 12));
          rect.setAttribute('y', '1');
          rect.setAttribute('width', '8');
          rect.setAttribute('height', '12');
          rect.setAttribute('rx', '2');

          const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
          if (run) {
            rect.setAttribute('fill', run.ok ? '#10b981' : '#ef4444');
            titleEl.textContent = `Run ${cellIdx + 1}: ${run.ok ? 'Success' : 'Failed'} (${relativeTime(run.at)})`;
          } else {
            rect.setAttribute('fill', '#cbd5e1');
            rect.setAttribute('class', 'dark:fill-slate-700');
            titleEl.textContent = 'No recorded run';
          }
          rect.appendChild(titleEl);
          svg.appendChild(rect);
        }
        tdRuns.appendChild(svg);
        tr.appendChild(tdRuns);

        // 6. Actions Column
        const tdActions = document.createElement('td');
        tdActions.className = 'py-3 whitespace-nowrap';
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'flex items-center gap-2';

        const runBtn = document.createElement('button');
        runBtn.type = 'button';
        runBtn.className = 'rounded-lg bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-all';
        runBtn.textContent = 'Run Now';
        runBtn.addEventListener('click', () => {
          const targetArticle = document.querySelector(`article[data-pipeline="${p.channel === 'account_analytics' ? 'analytics' : 'top_pins'}"]`);
          const runActionBtn = targetArticle?.querySelector('button[data-action="run"]') as HTMLButtonElement;
          if (runActionBtn) {
            runActionBtn.click();
          }
        });

        const logsBtn = document.createElement('button');
        logsBtn.type = 'button';
        logsBtn.className = 'rounded-lg border border-slate-300 dark:border-border bg-card px-2.5 py-1 text-xs font-semibold text-slate-700 dark:text-foreground hover:bg-muted transition-all';
        logsBtn.textContent = 'View Logs';
        logsBtn.addEventListener('click', () => {
          const targetArticle = document.querySelector(`article[data-pipeline="${p.channel === 'account_analytics' ? 'analytics' : 'top_pins'}"]`);
          const logsActionBtn = targetArticle?.querySelector('button[data-action="logs"]') as HTMLButtonElement;
          if (logsActionBtn) {
            logsActionBtn.click();
          }
        });

        actionsDiv.appendChild(runBtn);
        actionsDiv.appendChild(logsBtn);
        tdActions.appendChild(actionsDiv);
        tr.appendChild(tdActions);

        tbody.appendChild(tr);
      });

      updateBulkBar();
    } catch (err: any) {
      console.error('Failed to load cron jobs', err);
      tbody.innerHTML = '';
      const errTr = document.createElement('tr');
      const errTd = document.createElement('td');
      errTd.colSpan = 7;
      errTd.className = 'py-4 text-center text-xs text-red-500';
      errTd.textContent = 'Failed to load cron jobs. ';

      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'underline font-bold ml-1 hover:text-red-700';
      retryBtn.textContent = 'Retry';
      retryBtn.addEventListener('click', () => loadCronJobs());
      errTd.appendChild(retryBtn);
      errTr.appendChild(errTd);
      tbody.appendChild(errTr);
    }
  }

  // Bind save buttons
  document.querySelectorAll('button[data-action="save"]').forEach(btn => {
    btn.removeAttribute('disabled');
    btn.addEventListener('click', async (e) => {
      const target = (e.target as HTMLElement).closest('article');
      if (!target) return;
      const isTopPins = target.getAttribute('data-pipeline') === 'top_pins';
      
      const clampInt = (raw: any, fallback: number, min: number, max: number) => {
        const n = parseInt(raw, 10);
        if (isNaN(n)) return fallback;
        if (n < min) return min;
        if (n > max) return max;
        return n;
      };

      const payload: any = {};
      
      if (isTopPins) {
        payload.top_pins_webhook_url = (target.querySelector('[data-field="webhook_url"]') as HTMLInputElement).value;
        payload.top_pins_sync_time = (target.querySelector('[data-field="sync_time"]') as HTMLInputElement).value;
        payload.top_pins_start_offset_days = clampInt((target.querySelector('[data-field="start_offset"]') as HTMLInputElement).value, 7, 1, 90);
        payload.top_pins_end_offset_days = clampInt((target.querySelector('[data-field="end_offset"]') as HTMLInputElement).value, 2, 0, 60);
        payload.top_pins_num_of_pins = clampInt((target.querySelector('[data-field="num_of_pins"]') as HTMLInputElement).value, 50, 1, 50);
        
        const modes: string[] = [];
        target.querySelectorAll('[data-mode][aria-pressed="true"]').forEach(b => modes.push(b.getAttribute('data-mode')!));
        payload.top_pins_sort_modes = modes;

        const tokenVal = (target.querySelector('[data-field="fastcron_token"]') as HTMLInputElement)?.value;
        if (tokenVal !== undefined && tokenVal.trim().length > 0) {
          payload.top_pins_fastcron_token = tokenVal.trim();
        }
      } else {
        payload.analytics_webhook_url = (target.querySelector('[data-field="webhook_url"]') as HTMLInputElement).value;
        payload.analytics_sync_time = (target.querySelector('[data-field="sync_time"]') as HTMLInputElement).value;
        payload.analytics_start_offset_days = clampInt((target.querySelector('[data-field="start_offset"]') as HTMLInputElement).value, 7, 1, 90);
        payload.analytics_end_offset_days = clampInt((target.querySelector('[data-field="end_offset"]') as HTMLInputElement).value, 1, 0, 60);

        const tokenVal = (target.querySelector('[data-field="fastcron_token"]') as HTMLInputElement)?.value;
        if (tokenVal !== undefined && tokenVal.trim().length > 0) {
          payload.analytics_fastcron_token = tokenVal.trim();
        }
      }
      
      // Add fastcron settings globally
      const fc = document.getElementById('fastcron-options-card');
      if (fc) {
        payload.fastcron_notify = (fc.querySelector('[data-field="fastcron_notify"]') as HTMLInputElement).checked;
        payload.fastcron_timeout = clampInt((fc.querySelector('[data-field="fastcron_timeout"]') as HTMLInputElement).value, 30, 5, 60);
        payload.fastcron_instances = clampInt((fc.querySelector('[data-field="fastcron_instances"]') as HTMLInputElement).value, 1, 0, 5);
      }
      
      try {
        btn.textContent = 'Saving...';
        btn.setAttribute('disabled', 'true');
        const targetErr = target.querySelector('.inline-error');
        if (targetErr) targetErr.remove();

        const res = await fetch(`/api/analytics/connections/${pipeConnId}/settings`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          btn.textContent = 'Saved!';
          showToast('Settings saved successfully');
          setTimeout(() => {
            btn.textContent = 'Save Settings';
            btn.removeAttribute('disabled');
          }, 2000);
          loadPipelineSettings();
          loadCronJobs();
        } else {
          const contentType = res.headers.get('content-type');
          let msg = 'Failed to save';
          if (contentType?.includes('application/json')) {
            const err = await res.json();
            msg = err.error || msg;
          } else {
            msg = await res.text();
          }
          showInlineError(target, `HTTP ${res.status}: ${msg}`);
          btn.textContent = 'Save Settings';
          btn.removeAttribute('disabled');
        }
      } catch (err: any) {
        showInlineError(target, err.message || 'Network error');
        btn.textContent = 'Save Settings';
        btn.removeAttribute('disabled');
      }
    });
  });

  // Bind Sort Mode toggles
  document.querySelectorAll('#sort-modes-container button[data-mode]').forEach(b => {
    b.addEventListener('click', () => {
      const isPressed = b.getAttribute('aria-pressed') === 'true';
      if (isPressed) {
        b.setAttribute('aria-pressed', 'false');
        b.className = 'rounded-lg border border-border bg-card px-2.5 py-1 text-[10px] font-bold text-muted-foreground hover:bg-muted';
      } else {
        b.setAttribute('aria-pressed', 'true');
        b.className = 'rounded-lg border border-primary/40 bg-primary/10 px-2.5 py-1 text-[10px] font-bold text-primary';
      }
    });
  });

  // Action Buttons: Test Ping, Run Now, Sync Schedule, View Logs
  document.querySelectorAll('button[data-action="ping"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const target = (e.target as HTMLElement).closest('article');
      if (!target) return;
      const channel = target.getAttribute('data-pipeline') || 'analytics';
      const origText = btn.textContent;
      btn.setAttribute('disabled', 'true');
      btn.textContent = 'Pinging...';
      const targetErr = target.querySelector('.inline-error');
      if (targetErr) targetErr.remove();

      try {
        const res = await fetch('/api/analytics/trigger-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ connection_id: pipeConnId, channel, mode: 'ping' }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          showToast(`Ping Success: ${data.message || 'Make.com webhook reached'}`);
        } else {
          const msg = data.error || data.message || `HTTP ${res.status}: Ping failed`;
          showInlineError(target, msg);
        }
      } catch (err: any) {
        showInlineError(target, err.message || 'Network error on ping');
      } finally {
        btn.removeAttribute('disabled');
        btn.textContent = origText;
      }
    });
  });

  document.querySelectorAll('button[data-action="run"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const target = (e.target as HTMLElement).closest('article');
      if (!target) return;
      const channel = target.getAttribute('data-pipeline') || 'analytics';
      const origText = btn.textContent;
      btn.setAttribute('disabled', 'true');
      btn.textContent = 'Running...';
      const targetErr = target.querySelector('.inline-error');
      if (targetErr) targetErr.remove();

      const overrideFrom = (target.querySelector('[data-field="override_from"]') as HTMLInputElement)?.value;
      const overrideTo = (target.querySelector('[data-field="override_to"]') as HTMLInputElement)?.value;
      const body: any = { connection_id: pipeConnId, channel, mode: 'sync' };
      if (overrideFrom && overrideTo) {
        body.from_date = overrideFrom;
        body.to_date = overrideTo;
      }

      try {
        const res = await fetch('/api/analytics/trigger-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          showToast(`Run Success: ${data.message || 'Sync triggered successfully'}`);
          loadPipelineSettings();
          loadCronJobs();
        } else {
          const msg = data.error || data.message || `HTTP ${res.status}: Run failed`;
          showInlineError(target, msg);
        }
      } catch (err: any) {
        showInlineError(target, err.message || 'Network error on run');
      } finally {
        btn.removeAttribute('disabled');
        btn.textContent = origText;
      }
    });
  });

  document.querySelectorAll('button[data-action="sync"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const target = (e.target as HTMLElement).closest('article');
      if (!target) return;
      const channel = target.getAttribute('data-pipeline') || 'analytics';
      const origText = btn.textContent;
      btn.setAttribute('disabled', 'true');
      btn.textContent = 'Syncing...';
      const targetErr = target.querySelector('.inline-error');
      if (targetErr) targetErr.remove();

      try {
        const res = await fetch('/api/analytics/schedule/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ connection_id: pipeConnId, channel }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          showToast(`Schedule Synced: FastCron Job #${data.fastcron_job_id || 'Active'}`);
          loadPipelineSettings();
          loadCronJobs();
        } else {
          const msg = data.error || data.message || `HTTP ${res.status}: Schedule sync failed`;
          showInlineError(target, msg);
        }
      } catch (err: any) {
        showInlineError(target, err.message || 'Network error on schedule sync');
      } finally {
        btn.removeAttribute('disabled');
        btn.textContent = origText;
      }
    });
  });

  document.querySelectorAll('button[data-action="logs"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const target = (e.target as HTMLElement).closest('article');
      if (!target) return;
      const channel = target.getAttribute('data-pipeline') || 'analytics';
      const origText = btn.textContent;
      btn.setAttribute('disabled', 'true');
      btn.textContent = 'Fetching logs...';
      const targetErr = target.querySelector('.inline-error');
      if (targetErr) targetErr.remove();

      try {
        const res = await fetch(`/api/analytics/cron/logs?connection_id=${pipeConnId}&channel=${channel}`);
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          const count = Array.isArray(data.logs) ? data.logs.length : 0;
          showToast(`FastCron Logs: ${count} run(s) recorded`);
          if (count > 0) {
            console.table(data.logs);
          }
        } else {
          const msg = data.error || data.message || `HTTP ${res.status}: Fetch logs failed`;
          showInlineError(target, msg);
        }
      } catch (err: any) {
        showInlineError(target, err.message || 'Network error on fetch logs');
      } finally {
        btn.removeAttribute('disabled');
        btn.textContent = origText;
      }
    });
  });

  // Copy webhook URL buttons (event delegation)
  document.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-action="copy-webhook"]');
    if (!btn) return;
    const parent = btn.closest('.sm\\:col-span-2') || btn.closest('label') || btn.parentElement;
    const input = parent?.querySelector('input[data-field="webhook_url"]') as HTMLInputElement;
    if (!input || !input.value) {
      showToast('No webhook URL to copy', false);
      return;
    }
    try {
      await navigator.clipboard.writeText(input.value);
      const origText = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => {
        btn.textContent = origText || 'Copy';
      }, 2000);
      showToast('Webhook URL copied to clipboard');
    } catch {
      showToast('Failed to copy to clipboard', false);
    }
  });

  // Cron Select All Header Checkbox
  const selectAllHeader = document.getElementById('cron-select-all') as HTMLInputElement;
  if (selectAllHeader) {
    selectAllHeader.addEventListener('change', () => {
      const boxes = document.querySelectorAll('.cron-job-checkbox') as NodeListOf<HTMLInputElement>;
      boxes.forEach(b => { b.checked = selectAllHeader.checked; });
      updateBulkBar();
    });
  }

  // Cron Bulk Clear Button
  const bulkClearBtn = document.getElementById('cron-bulk-clear');
  if (bulkClearBtn) {
    bulkClearBtn.addEventListener('click', () => {
      const boxes = document.querySelectorAll('.cron-job-checkbox') as NodeListOf<HTMLInputElement>;
      boxes.forEach(b => { b.checked = false; });
      updateBulkBar();
    });
  }

  // Cron Bulk Run Now
  const bulkRunBtn = document.getElementById('cron-bulk-run');
  if (bulkRunBtn) {
    bulkRunBtn.addEventListener('click', () => {
      const job_ids = getSelectedJobIds();
      if (job_ids.length === 0) return;

      const form = document.createElement('div');
      form.className = 'space-y-3';
      form.innerHTML = `
        <p class="text-slate-600 dark:text-muted-foreground">Trigger manual execution across <strong>${job_ids.length}</strong> selected FastCron job(s).</p>
        <div class="grid grid-cols-2 gap-3 border-t border-border pt-3">
          <label class="space-y-1">
            <span class="font-semibold text-muted-foreground">Override From Date (Optional)</span>
            <input id="bulk-run-from" type="date" class="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs" />
          </label>
          <label class="space-y-1">
            <span class="font-semibold text-muted-foreground">Override To Date (Optional)</span>
            <input id="bulk-run-to" type="date" class="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs" />
          </label>
        </div>
        <p class="text-[11px] text-muted-foreground">Leave dates blank to use connection offset defaults. Same-day date ranges (start == end) are fully supported.</p>
      `;

      showCronModal({
        title: 'Bulk Run Now',
        bodyNode: form,
        confirmLabel: 'Run Selected Jobs',
        onConfirm: async () => {
          const fromInput = document.getElementById('bulk-run-from') as HTMLInputElement;
          const toInput = document.getElementById('bulk-run-to') as HTMLInputElement;
          const from_date = fromInput?.value || undefined;
          const to_date = toInput?.value || undefined;

          if (from_date && to_date && from_date > to_date) {
            throw new Error('Start Date must be before End Date (identical dates allowed for same-day pull).');
          }

          const res = await fetch('/api/analytics/cron/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'run',
              job_ids,
              options: from_date && to_date ? { from_date, to_date } : undefined,
            }),
          });
          const data = await res.json();
          if (res.ok && data.success) {
            showToast(`Bulk Run Triggered: ${data.results?.filter((r: any) => r.success).length}/${job_ids.length} successful`);
            await loadCronJobs();
          } else {
            throw new Error(data.error || 'Bulk Run failed');
          }
        },
      });
    });
  }

  // Cron Bulk Enable
  const bulkEnableBtn = document.getElementById('cron-bulk-enable');
  if (bulkEnableBtn) {
    bulkEnableBtn.addEventListener('click', async () => {
      const job_ids = getSelectedJobIds();
      if (job_ids.length === 0) return;

      const body = document.createElement('div');
      body.innerHTML = `<p class="text-slate-600 dark:text-muted-foreground">Enable <strong>${job_ids.length}</strong> selected FastCron job(s)?</p>`;

      showCronModal({
        title: 'Bulk Enable Jobs',
        bodyNode: body,
        confirmLabel: 'Enable Jobs',
        confirmClass: 'rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-700',
        onConfirm: async () => {
          const res = await fetch('/api/analytics/cron/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'enable', job_ids }),
          });
          const data = await res.json();
          if (res.ok && data.success) {
            showToast(`Jobs Enabled: ${data.results?.filter((r: any) => r.success).length}/${job_ids.length} active`);
            await loadCronJobs();
          } else {
            throw new Error(data.error || 'Bulk enable failed');
          }
        },
      });
    });
  }

  // Cron Bulk Disable
  const bulkDisableBtn = document.getElementById('cron-bulk-disable');
  if (bulkDisableBtn) {
    bulkDisableBtn.addEventListener('click', async () => {
      const job_ids = getSelectedJobIds();
      if (job_ids.length === 0) return;

      const body = document.createElement('div');
      body.innerHTML = `<p class="text-slate-600 dark:text-muted-foreground">Disable <strong>${job_ids.length}</strong> selected FastCron job(s)? Scheduled runs will pause.</p>`;

      showCronModal({
        title: 'Bulk Disable Jobs',
        bodyNode: body,
        confirmLabel: 'Disable Jobs',
        confirmClass: 'rounded-xl bg-amber-600 px-4 py-2 text-xs font-bold text-white hover:bg-amber-700',
        onConfirm: async () => {
          const res = await fetch('/api/analytics/cron/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'disable', job_ids }),
          });
          const data = await res.json();
          if (res.ok && data.success) {
            showToast(`Jobs Disabled: ${data.results?.filter((r: any) => r.success).length}/${job_ids.length} disabled`);
            await loadCronJobs();
          } else {
            throw new Error(data.error || 'Bulk disable failed');
          }
        },
      });
    });
  }

  // Cron Bulk Pause
  const bulkPauseBtn = document.getElementById('cron-bulk-pause');
  if (bulkPauseBtn) {
    bulkPauseBtn.addEventListener('click', () => {
      const job_ids = getSelectedJobIds();
      if (job_ids.length === 0) return;

      const form = document.createElement('div');
      form.className = 'space-y-3';
      form.innerHTML = `
        <p class="text-slate-600 dark:text-muted-foreground">Temporarily pause <strong>${job_ids.length}</strong> selected job(s) for a set duration:</p>
        <label class="space-y-1 block">
          <span class="font-semibold text-muted-foreground">Pause Duration</span>
          <select id="bulk-pause-duration" class="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs focus:border-primary focus:outline-none">
            <option value="15 minutes">15 minutes</option>
            <option value="30 minutes">30 minutes</option>
            <option value="45 minutes">45 minutes</option>
            <option value="1 hour" selected>1 hour (Default)</option>
            <option value="2 hours">2 hours</option>
            <option value="6 hours">6 hours</option>
            <option value="12 hours">12 hours</option>
            <option value="1 day">1 day</option>
            <option value="2 days">2 days</option>
            <option value="7 days">7 days</option>
          </select>
        </label>
      `;

      showCronModal({
        title: 'Bulk Pause Jobs',
        bodyNode: form,
        confirmLabel: 'Pause Jobs',
        onConfirm: async () => {
          const select = document.getElementById('bulk-pause-duration') as HTMLSelectElement;
          const forExpr = select?.value || '1 hour';
          const res = await fetch('/api/analytics/cron/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'pause', job_ids, options: { for: forExpr } }),
          });
          const data = await res.json();
          if (res.ok && data.success) {
            showToast(`Jobs Paused: ${data.results?.filter((r: any) => r.success).length}/${job_ids.length} for ${forExpr}`);
            await loadCronJobs();
          } else {
            throw new Error(data.error || 'Bulk pause failed');
          }
        },
      });
    });
  }

  // Cron Bulk Delete
  const bulkDeleteBtn = document.getElementById('cron-bulk-delete');
  if (bulkDeleteBtn) {
    bulkDeleteBtn.addEventListener('click', () => {
      const job_ids = getSelectedJobIds();
      if (job_ids.length === 0) return;

      const form = document.createElement('div');
      form.className = 'space-y-3';
      form.innerHTML = `
        <div class="rounded-xl bg-red-500/10 border border-red-500/20 p-3 text-red-600 dark:text-red-400">
          <p class="font-bold">Warning: Permanent Action</p>
          <p class="mt-1">This will permanently delete <strong>${job_ids.length}</strong> FastCron job(s) from FastCron and reset local schedules to pending.</p>
        </div>
        <label class="space-y-1 block">
          <span class="font-semibold text-muted-foreground">Type <strong>DELETE</strong> to confirm:</span>
          <input id="bulk-delete-confirm-input" type="text" placeholder="DELETE" class="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs focus:border-red-500 focus:outline-none" />
        </label>
      `;

      showCronModal({
        title: 'Delete FastCron Jobs',
        bodyNode: form,
        confirmLabel: 'Permanently Delete',
        confirmClass: 'rounded-xl bg-red-600 px-4 py-2 text-xs font-bold text-white hover:bg-red-700',
        onConfirm: async () => {
          const input = document.getElementById('bulk-delete-confirm-input') as HTMLInputElement;
          if (input?.value.trim() !== 'DELETE') {
            throw new Error('Please type DELETE to confirm');
          }

          const res = await fetch('/api/analytics/cron/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete', job_ids }),
          });
          const data = await res.json();
          if (res.ok && data.success) {
            showToast(`Jobs Deleted: ${data.results?.filter((r: any) => r.success).length}/${job_ids.length}`);
            loadPipelineSettings();
            await loadCronJobs();
          } else {
            throw new Error(data.error || 'Bulk delete failed');
          }
        },
      });
    });
  }

  // Cron Bulk Logs
  const bulkLogsBtn = document.getElementById('cron-bulk-logs');
  if (bulkLogsBtn) {
    bulkLogsBtn.addEventListener('click', async () => {
      const job_ids = getSelectedJobIds();
      if (job_ids.length === 0) return;

      const res = await fetch('/api/analytics/cron/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'logs', job_ids }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        showToast(data.error || 'Failed to fetch logs', false);
        return;
      }

      const logs: any[] = Array.isArray(data.data) ? data.data : [];
      const container = document.createElement('div');
      container.className = 'space-y-2';

      if (logs.length === 0) {
        container.innerHTML = '<p class="text-center py-6 text-muted-foreground">No execution logs found for selected jobs.</p>';
      } else {
        const table = document.createElement('table');
        table.className = 'w-full text-left text-xs';
        table.innerHTML = `
          <thead>
            <tr class="border-b border-border text-[10px] uppercase font-bold text-muted-foreground">
              <th class="py-2 pr-2">Time</th>
              <th class="py-2 pr-2">Job</th>
              <th class="py-2 pr-2">Status</th>
              <th class="py-2 pr-2">HTTP</th>
              <th class="py-2">Duration</th>
            </tr>
          </thead>
          <tbody>
            ${logs.slice(0, 50).map(l => `
              <tr class="border-b border-border/50 hover:bg-muted/20">
                <td class="py-2 pr-2 font-mono whitespace-nowrap">${escapeHtml(relativeTime(l.date || l.started_at || l.time))}</td>
                <td class="py-2 pr-2 font-mono font-bold">#${escapeHtml(l.job_id)}</td>
                <td class="py-2 pr-2"><span class="inline-flex rounded px-1.5 py-0.5 text-[10px] font-bold ${l.status === 'OK' || l.status === 'success' || (l.http_code && l.http_code < 400) ? 'bg-emerald-500/10 text-emerald-600' : 'bg-red-500/10 text-red-600'}">${escapeHtml(l.status || 'Done')}</span></td>
                <td class="py-2 pr-2 font-mono">${escapeHtml(l.http_code || l.code || '200')}</td>
                <td class="py-2 font-mono text-muted-foreground">${l.duration ? `${escapeHtml(l.duration)}s` : '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        `;
        container.appendChild(table);
      }

      showCronModal({
        title: `Aggregated Execution Logs (${logs.length} entries)`,
        bodyNode: container,
        confirmLabel: 'Close',
        showCancel: false,
      });
    });
  }

  // Cron Bulk Failures
  const bulkFailuresBtn = document.getElementById('cron-bulk-failures');
  if (bulkFailuresBtn) {
    bulkFailuresBtn.addEventListener('click', async () => {
      const job_ids = getSelectedJobIds();
      if (job_ids.length === 0) return;

      const res = await fetch('/api/analytics/cron/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'failures', job_ids }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        showToast(data.error || 'Failed to fetch failure history', false);
        return;
      }

      const failures: any[] = Array.isArray(data.data) ? data.data : [];
      const container = document.createElement('div');

      if (failures.length === 0) {
        container.innerHTML = '<p class="text-center py-6 text-emerald-600 dark:text-emerald-400 font-semibold">🎉 Zero failure records found for selected jobs!</p>';
      } else {
        const table = document.createElement('table');
        table.className = 'w-full text-left text-xs';
        table.innerHTML = `
          <thead>
            <tr class="border-b border-border text-[10px] uppercase font-bold text-muted-foreground">
              <th class="py-2 pr-2">Time</th>
              <th class="py-2 pr-2">Job</th>
              <th class="py-2 pr-2">HTTP</th>
              <th class="py-2">Error Message</th>
            </tr>
          </thead>
          <tbody>
            ${failures.map(f => `
              <tr class="border-b border-border/50 hover:bg-muted/20">
                <td class="py-2 pr-2 font-mono whitespace-nowrap text-red-500">${escapeHtml(relativeTime(f.date || f.started_at || f.time))}</td>
                <td class="py-2 pr-2 font-mono font-bold">#${escapeHtml(f.job_id)}</td>
                <td class="py-2 pr-2 font-mono text-red-500">${escapeHtml(f.http_code || f.code || '500')}</td>
                <td class="py-2 text-slate-700 dark:text-foreground font-mono text-[11px]">${escapeHtml(f.message || f.error || 'Request failure')}</td>
              </tr>
            `).join('')}
          </tbody>
        `;
        container.appendChild(table);
      }

      showCronModal({
        title: `Failure Records (${failures.length} issues)`,
        bodyNode: container,
        confirmLabel: 'Close',
        showCancel: false,
      });
    });
  }

  // Cron Bulk Next Runs
  const bulkNextBtn = document.getElementById('cron-bulk-next');
  if (bulkNextBtn) {
    bulkNextBtn.addEventListener('click', async () => {
      const job_ids = getSelectedJobIds();
      if (job_ids.length === 0) return;

      const res = await fetch('/api/analytics/cron/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'next', job_ids }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        showToast(data.error || 'Failed to fetch next runs', false);
        return;
      }

      const container = document.createElement('div');
      container.className = 'space-y-4';

      const nextData = data.data || {};
      for (const jId of job_ids) {
        const item = nextData[jId];
        const card = document.createElement('div');
        card.className = 'rounded-xl border border-border bg-card p-3 space-y-2';
        const runsList = Array.isArray(item?.runs) ? item.runs : [];
        card.innerHTML = `
          <div class="flex items-center justify-between">
            <span class="font-bold text-foreground">Job #${jId} (${item?.display_name || 'Pipeline'})</span>
            <span class="font-mono text-xs text-muted-foreground">${item?.channel || ''}</span>
          </div>
          <ul class="space-y-1 font-mono text-xs text-slate-700 dark:text-foreground pl-2 border-l-2 border-primary/40">
            ${runsList.length > 0 ? runsList.slice(0, 3).map((r: any) => `<li>• ${typeof r === 'string' ? r : r.time || r.date || JSON.stringify(r)}</li>`).join('') : '<li class="text-muted-foreground text-[11px]">— No upcoming runs returned —</li>'}
          </ul>
        `;
        container.appendChild(card);
      }

      showCronModal({
        title: 'Upcoming FastCron Executions',
        bodyNode: container,
        confirmLabel: 'Close',
        showCancel: false,
      });
    });
  }

  // Cron Bulk Edit
  const bulkEditBtn = document.getElementById('cron-bulk-edit');
  if (bulkEditBtn) {
    bulkEditBtn.addEventListener('click', () => {
      const job_ids = getSelectedJobIds();
      if (job_ids.length === 0) return;

      const form = document.createElement('div');
      form.className = 'space-y-3';
      form.innerHTML = `
        <p class="text-slate-600 dark:text-muted-foreground">Update configuration settings across <strong>${job_ids.length}</strong> selected FastCron job(s):</p>
        <div class="grid grid-cols-2 gap-3">
          <label class="space-y-1 block">
            <span class="font-semibold text-muted-foreground">Timeout (5–60s)</span>
            <input id="bulk-edit-timeout" type="number" min="5" max="60" placeholder="30" class="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs" />
          </label>
          <label class="space-y-1 block">
            <span class="font-semibold text-muted-foreground">Max Concurrent Instances (0–5)</span>
            <input id="bulk-edit-instances" type="number" min="0" max="5" placeholder="1" class="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs" />
          </label>
        </div>
        <label class="flex items-center gap-2 pt-2 cursor-pointer">
          <input id="bulk-edit-notify" type="checkbox" checked class="rounded border-border text-primary focus:ring-primary h-4 w-4" />
          <span class="font-semibold text-foreground">Notify on job failure</span>
        </label>
      `;

      showCronModal({
        title: 'Bulk Edit FastCron Settings',
        bodyNode: form,
        confirmLabel: 'Apply Settings',
        onConfirm: async () => {
          const timeoutInput = document.getElementById('bulk-edit-timeout') as HTMLInputElement;
          const instancesInput = document.getElementById('bulk-edit-instances') as HTMLInputElement;
          const notifyInput = document.getElementById('bulk-edit-notify') as HTMLInputElement;

          const options: Record<string, any> = {
            notify: notifyInput ? notifyInput.checked : true,
          };
          if (timeoutInput?.value) options.timeout = Number(timeoutInput.value);
          if (instancesInput?.value) options.instances = Number(instancesInput.value);

          const res = await fetch('/api/analytics/cron/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'edit', job_ids, options }),
          });
          const data = await res.json();
          if (res.ok && data.success) {
            showToast(`Settings Updated on ${data.results?.filter((r: any) => r.success).length}/${job_ids.length} jobs`);
            await loadCronJobs();
          } else {
            throw new Error(data.error || 'Bulk edit failed');
          }
        },
      });
    });
  }

  // Cron Sync Missing
  const syncMissingBtn = document.getElementById('cron-bulk-sync-missing');
  if (syncMissingBtn) {
    syncMissingBtn.addEventListener('click', async () => {
      syncMissingBtn.setAttribute('disabled', 'true');
      const orig = syncMissingBtn.innerHTML;
      syncMissingBtn.innerHTML = '<span>⚡</span><span>Syncing...</span>';

      try {
        const res = await fetch('/api/analytics/cron/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'sync_missing' }),
        });
        const data = await res.json();
        if (res.ok && data.success) {
          const added = Array.isArray(data.results) ? data.results.filter((r: any) => r.success).length : 0;
          showToast(`FastCron Sync Complete: ${added} missing job(s) provisioned.`);
          loadPipelineSettings();
          await loadCronJobs();
        } else {
          showToast(data.error || 'Sync missing failed', false);
        }
      } catch (err: any) {
        showToast(err.message || 'Network error on sync missing', false);
      } finally {
        syncMissingBtn.removeAttribute('disabled');
        syncMissingBtn.innerHTML = orig;
      }
    });
  }

  loadPipelineSettings();
  loadCronJobs();

  let settingsLoadedAt = 0;
  const SETTINGS_TTL_MS = 30_000;
  document.querySelectorAll('[role="tab"]').forEach(t => {
    t.addEventListener('click', () => {
      if (t.getAttribute('data-tab') !== 'pipeline') return;
      if (Date.now() - settingsLoadedAt <= SETTINGS_TTL_MS) return;
      settingsLoadedAt = Date.now();
      loadPipelineSettings();
      loadCronJobs();
    });
  });
}

