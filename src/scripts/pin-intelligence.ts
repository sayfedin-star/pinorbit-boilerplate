import { formatNum, formatPct, fmtMetric, escapeHtml } from './formatters';

const intelConnectionEl = document.querySelector('[data-connection-id]');
const intelConnId = intelConnectionEl?.getAttribute('data-connection-id');

if (intelConnId) {
  // State
  const state = {
    mode: 'IMPRESSION',
    days: 30,
    page: 1,
    pageSize: 25,
    sort: 'total_impressions',
    sortDir: 'desc' as 'asc' | 'desc',
    search: '',
    minImpressions: '',
    minAppearances: '',
    trend: 'ALL',
    hasLink: '',
  };

  let searchTimeout: any = null;
  let hasLoadedIntel = false;
  let currentItems: any[] = [];
  let totalUnique = 0;

  // Drawer state
  let activeDrawerPin: any = null;
  let activeDrawerDays = 90;
  let activeDrawerMetricIndex = 0;
  let activeDrawerTimelinePoints: any[] = [];
  let lastActiveLeaderboardRow: HTMLElement | null = null;

  const tbody = document.getElementById('intel-leaderboard-tbody');
  const drawer = document.getElementById('intel-timeline-drawer');
  const drawerBackdrop = document.getElementById('intel-drawer-backdrop');
  const drawerCloseBtn = document.getElementById('intel-drawer-close');

  const STORAGE_KEY_COLS = 'pin_orbit_intel_col_visibility';

  const TREND_METRICS = [
    { key: 'impressions', label: 'Impressions', rateKey: null },
    { key: 'engagements', label: 'Engagements', rateKey: 'engagement_rate' },
    { key: 'saves', label: 'Saves', rateKey: 'save_rate' },
    { key: 'outbound_clicks', label: 'Outbound Clicks', rateKey: 'outbound_click_rate' },
    { key: 'pin_clicks', label: 'Pin Clicks', rateKey: 'pin_click_rate' },
    { key: 'rank_position', label: 'Rank', rateKey: null, invert: true },
  ] as const;

  const rateOr = (item: any, rateKey: string, countKey: string): number | null =>
    typeof item?.[rateKey] === 'number' && Number.isFinite(item[rateKey])
      ? item[rateKey]
      : (item?.total_impressions > 0
          ? (item?.[countKey === 'engagements' ? 'total_engagements' :
                    countKey === 'saves' ? 'total_saves' :
                    countKey === 'outbound_clicks' ? 'total_outbound_clicks' :
                    'total_pin_clicks'] ?? 0) / item.total_impressions
          : null);

  function renderTrendBadge(trend: string): string {
    if (!trend) return `<span class="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">▬</span>`;
    if (trend.startsWith('▲')) {
      return `<span class="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-bold text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">${escapeHtml(trend)}</span>`;
    }
    if (trend.startsWith('▼')) {
      return `<span class="inline-flex items-center gap-0.5 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-bold text-rose-600 dark:text-rose-400 border border-rose-500/20">${escapeHtml(trend)}</span>`;
    }
    if (trend === 'NEW') {
      return `<span class="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-bold text-primary border border-primary/20">NEW</span>`;
    }
    return `<span class="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">▬</span>`;
  }

  function renderDeltaChip(text: string, type: 'up' | 'down' | 'neutral' | 'none') {
    if (type === 'none' || type === 'neutral' || !text || text === '▬') return '';
    if (type === 'up') {
      return `<span class="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20">${escapeHtml(text)}</span>`;
    }
    if (type === 'down') {
      return `<span class="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-bold text-rose-600 dark:text-rose-400 bg-rose-500/10 border border-rose-500/20">${escapeHtml(text)}</span>`;
    }
    return '';
  }

  // Column Visibility Management
  function getVisibleColumns(): Record<string, boolean> {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_COLS);
      if (saved) return JSON.parse(saved);
    } catch {}
    return {
      appearances: true,
      best_rank: true,
      total_impressions: true,
      total_engagements: true,
      total_outbound_clicks: true,
      total_pin_clicks: true,
      total_saves: true,
      last_seen: true,
      trend: true,
    };
  }

  function saveVisibleColumns(cols: Record<string, boolean>) {
    try {
      localStorage.setItem(STORAGE_KEY_COLS, JSON.stringify(cols));
    } catch {}
  }

  function applyColumnVisibility() {
    const cols = getVisibleColumns();

    // Update checkboxes in dropdown
    document.querySelectorAll<HTMLInputElement>('#intel-col-menu input[data-col]').forEach(cb => {
      const colName = cb.getAttribute('data-col');
      if (colName && cols[colName] !== undefined) {
        cb.checked = cols[colName];
      }
    });

    // Update table header and body cells
    Object.keys(cols).forEach(colName => {
      const isVisible = cols[colName] !== false;
      const headers = document.querySelectorAll<HTMLElement>(`th[data-intel-col="${colName}"]`);
      headers.forEach(th => {
        if (isVisible) th.classList.remove('hidden');
        else th.classList.add('hidden');
      });

      const cells = document.querySelectorAll<HTMLElement>(`td[data-intel-col="${colName}"]`);
      cells.forEach(td => {
        if (isVisible) td.classList.remove('hidden');
        else td.classList.add('hidden');
      });
    });
  }

  // URL State Sync
  function syncStateToUrl() {
    const p = new URLSearchParams(window.location.search);
    if (state.mode !== 'IMPRESSION') p.set('pi_mode', state.mode);
    else p.delete('pi_mode');

    if (state.days !== 30) p.set('pi_days', String(state.days));
    else p.delete('pi_days');

    if (state.page > 1) p.set('pi_page', String(state.page));
    else p.delete('pi_page');

    if (state.pageSize !== 25) p.set('pi_ps', String(state.pageSize));
    else p.delete('pi_ps');

    if (state.sort !== 'total_impressions') p.set('pi_sort', state.sort);
    else p.delete('pi_sort');

    if (state.sortDir !== 'desc') p.set('pi_dir', state.sortDir);
    else p.delete('pi_dir');

    if (state.search) p.set('pi_q', state.search);
    else p.delete('pi_q');

    if (state.minImpressions) p.set('pi_min_impr', state.minImpressions);
    else p.delete('pi_min_impr');

    if (state.minAppearances) p.set('pi_min_app', state.minAppearances);
    else p.delete('pi_min_app');

    if (state.trend && state.trend !== 'ALL') p.set('pi_trend', state.trend);
    else p.delete('pi_trend');

    if (state.hasLink) p.set('pi_link', state.hasLink);
    else p.delete('pi_link');

    const newSearch = p.toString();
    const newUrl = (newSearch ? '?' + newSearch : window.location.pathname) + window.location.hash;
    window.history.replaceState(null, '', newUrl);
  }

  function loadStateFromUrl() {
    const p = new URLSearchParams(window.location.search);
    state.mode = p.get('pi_mode') || 'IMPRESSION';
    state.days = parseInt(p.get('pi_days') || '30', 10);
    state.page = parseInt(p.get('pi_page') || '1', 10);
    state.pageSize = parseInt(p.get('pi_ps') || '25', 10);
    state.sort = p.get('pi_sort') || 'total_impressions';
    state.sortDir = (p.get('pi_dir') === 'asc' ? 'asc' : 'desc');
    state.search = p.get('pi_q') || '';
    state.minImpressions = p.get('pi_min_impr') || '';
    state.minAppearances = p.get('pi_min_app') || '';
    state.trend = p.get('pi_trend') || 'ALL';
    state.hasLink = p.get('pi_link') || '';

    // Update UI controls to match loaded state
    const searchInput = document.getElementById('intel-search') as HTMLInputElement;
    if (searchInput) searchInput.value = state.search;

    const minImprInput = document.getElementById('intel-min-impr') as HTMLInputElement;
    if (minImprInput) minImprInput.value = state.minImpressions;

    const minAppInput = document.getElementById('intel-min-app') as HTMLInputElement;
    if (minAppInput) minAppInput.value = state.minAppearances;

    const trendSelect = document.getElementById('intel-trend-filter') as HTMLSelectElement;
    if (trendSelect) trendSelect.value = state.trend;

    const linkSelect = document.getElementById('intel-link-filter') as HTMLSelectElement;
    if (linkSelect) linkSelect.value = state.hasLink;

    const psSelect = document.getElementById('intel-ps') as HTMLSelectElement;
    if (psSelect) psSelect.value = String(state.pageSize);

    // Update Sort Mode tabs
    document.querySelectorAll('#intel-sort-tabs button[data-intel-sort]').forEach(b => {
      if (b.getAttribute('data-intel-sort') === state.mode) {
        b.className = 'mode-tab active rounded-lg bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground shadow-sm transition-all';
      } else {
        b.className = 'mode-tab rounded-lg px-3 py-1 text-xs font-semibold text-muted-foreground transition-all hover:text-foreground';
      }
    });

    // Update Window presets
    document.querySelectorAll('#intel-range-presets button[data-intel-days]').forEach(b => {
      if (parseInt(b.getAttribute('data-intel-days') || '30', 10) === state.days) {
        b.className = 'preset-btn active rounded-lg bg-primary px-2.5 py-0.5 text-xs font-semibold text-primary-foreground shadow-sm transition-all';
      } else {
        b.className = 'preset-btn rounded-lg px-2.5 py-0.5 text-xs font-semibold text-muted-foreground hover:text-foreground transition-all';
      }
    });
  }

  function updateSortHeaders() {
    document.querySelectorAll<HTMLElement>('[data-intel-col]').forEach(th => {
      const colName = th.getAttribute('data-intel-col');
      const iconEl = th.querySelector('.sort-icon');
      if (iconEl) {
        if (colName === state.sort) {
          iconEl.textContent = state.sortDir === 'desc' ? ' ↓' : ' ↑';
        } else {
          iconEl.textContent = '';
        }
      }
    });
  }

  async function loadPinLeaderboard() {
    if (!tbody) return;

    syncStateToUrl();
    updateSortHeaders();

    tbody.innerHTML = `
      <tr>
        <td colspan="11" class="py-12 text-center text-muted-foreground">
          <div class="inline-flex items-center gap-2 text-xs font-semibold">
            <svg class="animate-spin h-4 w-4 text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
            </svg>
            <span>Loading ${state.mode.toLowerCase()} leaderboard (Page ${state.page})...</span>
          </div>
        </td>
      </tr>
    `;

    try {
      const url = new URL(`/api/analytics/connections/${intelConnId}/pin-leaderboard`, window.location.origin);
      url.searchParams.set('sort_by', state.mode);
      url.searchParams.set('days', String(state.days));
      url.searchParams.set('page', String(state.page));
      url.searchParams.set('page_size', String(state.pageSize));
      url.searchParams.set('sort', state.sort);
      url.searchParams.set('dir', state.sortDir);

      if (state.search) url.searchParams.set('q', state.search);
      if (state.minImpressions) url.searchParams.set('min_impressions', state.minImpressions);
      if (state.minAppearances) url.searchParams.set('min_appearances', state.minAppearances);
      if (state.trend && state.trend !== 'ALL') url.searchParams.set('trend', state.trend);
      if (state.hasLink) url.searchParams.set('has_link', state.hasLink);

      const res = await fetch(url.toString());
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `HTTP ${res.status}: Failed to load leaderboard`);
      }

      const json = await res.json();
      currentItems = json.data || [];
      totalUnique = Number(json.total_unique ?? currentItems.length);

      // Update Pagination Footer
      const totalEl = document.getElementById('intel-total');
      const rangeEl = document.getElementById('intel-range');
      if (totalEl) totalEl.textContent = String(totalUnique);

      const maxPage = Math.ceil(totalUnique / state.pageSize) || 1;
      if (state.page > maxPage && maxPage > 0) {
        state.page = maxPage;
        return loadPinLeaderboard();
      }

      const start = (state.page - 1) * state.pageSize;
      const end = Math.min(start + state.pageSize, totalUnique);
      if (rangeEl) rangeEl.textContent = totalUnique > 0 ? `${start + 1}–${end}` : '0-0';

      const btnDiv = document.getElementById('intel-page-buttons');
      if (btnDiv) {
        btnDiv.innerHTML = `
          <button class="px-2.5 py-1 rounded-lg bg-muted/40 hover:bg-muted text-xs font-semibold text-foreground disabled:opacity-40 transition-colors" ${state.page <= 1 ? 'disabled' : ''} data-intel-page="${state.page - 1}">Prev</button>
          <button class="px-2.5 py-1 rounded-lg bg-muted/40 hover:bg-muted text-xs font-semibold text-foreground disabled:opacity-40 transition-colors" ${state.page >= maxPage ? 'disabled' : ''} data-intel-page="${state.page + 1}">Next</button>
        `;

        btnDiv.querySelectorAll<HTMLButtonElement>('button[data-intel-page]').forEach(b => {
          b.addEventListener('click', () => {
            const p = parseInt(b.getAttribute('data-intel-page') || '1', 10);
            if (p >= 1 && p <= maxPage) {
              state.page = p;
              loadPinLeaderboard();
            }
          });
        });
      }

      if (currentItems.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="11" class="py-12 text-center text-muted-foreground">
              <div class="flex flex-col items-center justify-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 text-muted-foreground/50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="m4.93 4.93 4.24 4.24"/><path d="m14.83 9.17 4.24-4.24"/><path d="m14.83 14.83 4.24 4.24"/><path d="m9.17 14.83-4.24 4.24"/></svg>
                <p class="text-xs font-medium">No pins found matching criteria in the last ${state.days} days.</p>
                <p class="text-[11px] text-muted-foreground/70">Try adjusting filters, clearing search, or expanding date window.</p>
              </div>
            </td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = currentItems.map((item: any, idx: number) => {
        const titleText = item.title || `Pin #${item.pin_id}`;
        const pinIdShort = String(item.pin_id);
        const pLink = item.destination_url || `https://www.pinterest.com/pin/${item.pin_id}/`;
        const rankIndex = start + idx + 1;

        return `
          <tr class="hover:bg-muted/30 transition-colors cursor-pointer group" data-pin-id="${item.pin_id}" data-pin-json='${encodeURIComponent(JSON.stringify(item))}'>
            <td class="py-3 px-4 text-center font-bold text-muted-foreground w-12" data-intel-col="#">
              <span class="inline-flex items-center justify-center w-6 h-6 rounded-full text-xs ${rankIndex <= 3 ? 'bg-primary/10 text-primary font-black' : 'text-muted-foreground'}">
                ${rankIndex}
              </span>
            </td>
            <td class="py-3 px-4 min-w-[240px]" data-intel-col="pin">
              <div class="flex items-center gap-3">
                ${item.image_url 
                  ? `<img src="${escapeHtml(item.image_url)}" alt="" class="w-9 h-9 rounded-lg object-cover border border-border bg-muted shrink-0" loading="lazy" />` 
                  : `<div class="w-9 h-9 rounded-lg bg-muted border border-border flex items-center justify-center text-muted-foreground text-xs shrink-0 font-bold">📌</div>`
                }
                <div class="min-w-0 flex-1">
                  <div class="font-semibold text-foreground truncate text-xs group-hover:text-primary transition-colors" title="${escapeHtml(titleText)}">
                    ${escapeHtml(titleText)}
                  </div>
                  <div class="flex items-center gap-2 mt-0.5">
                    <span class="font-mono text-[10px] text-muted-foreground/80">ID: ${escapeHtml(pinIdShort)}</span>
                    <a href="${escapeHtml(pLink)}" target="_blank" rel="noopener noreferrer" class="text-[10px] text-primary/80 hover:text-primary hover:underline flex items-center gap-0.5" onclick="event.stopPropagation()">
                      <span>Link</span>
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    </a>
                  </div>
                </div>
              </div>
            </td>
            <td class="py-3 px-4 text-center font-semibold text-foreground tabular-nums" data-intel-col="appearances">
              <span class="rounded-md bg-muted px-2 py-0.5 text-xs font-mono">${formatNum(item.appearances)}</span>
            </td>
            <td class="py-3 px-4 text-center font-bold text-foreground tabular-nums" data-intel-col="best_rank">
              #${formatNum(item.best_rank)}
            </td>
            <td class="py-3 px-4 text-right font-medium text-foreground tabular-nums" data-intel-col="total_impressions">
              ${formatNum(item.total_impressions)}
            </td>
            <td class="py-3 px-4 text-right font-medium text-foreground tabular-nums" data-intel-col="total_engagements">
              ${fmtMetric(item.total_engagements, item.engagement_rate)}
            </td>
            <td class="py-3 px-4 text-right font-medium text-foreground tabular-nums" data-intel-col="total_outbound_clicks">
              ${fmtMetric(item.total_outbound_clicks, item.outbound_click_rate)}
            </td>
            <td class="py-3 px-4 text-right font-medium text-foreground tabular-nums" data-intel-col="total_pin_clicks">
              ${fmtMetric(item.total_pin_clicks, item.pin_click_rate)}
            </td>
            <td class="py-3 px-4 text-right font-medium text-foreground tabular-nums" data-intel-col="total_saves">
              ${fmtMetric(item.total_saves, item.save_rate)}
            </td>
            <td class="py-3 px-4 text-right font-mono text-[11px] text-muted-foreground" data-intel-col="last_seen">
              ${escapeHtml(item.last_seen) || '—'}
            </td>
            <td class="py-3 px-4 text-center" data-intel-col="trend">
              ${renderTrendBadge(item.trend)}
            </td>
          </tr>
        `;
      }).join('');

      applyColumnVisibility();

      // Bind row clicks to open timeline drawer
      tbody.querySelectorAll('tr[data-pin-json]').forEach(row => {
        row.addEventListener('click', () => {
          lastActiveLeaderboardRow = row as HTMLElement;
          const raw = row.getAttribute('data-pin-json');
          if (raw) {
            try {
              const item = JSON.parse(decodeURIComponent(raw));
              openTimelineDrawer(item);
            } catch (e) {
              console.error('Failed to parse pin item', e);
            }
          }
        });
      });

    } catch (err: any) {
      console.error('[PinIntelligence] Failed to load leaderboard:', err);
      tbody.innerHTML = `
        <tr>
          <td colspan="11" class="py-12 text-center text-rose-500 font-semibold text-xs">
            ${escapeHtml(err.message) || 'Error loading pin leaderboard.'}
          </td>
        </tr>
      `;
    }
  }

  // R1 & R3: Render 8 Stat Cards (Range-Consistent & Stacked)
  function renderDrawerStatCards(item: any, points: any[]) {
    const grid = document.getElementById('drawer-stat-cards-grid');
    const windowNotice = document.getElementById('drawer-window-notice');
    if (!grid) return;

    if (windowNotice) {
      windowNotice.textContent = `Totals (${activeDrawerDays}D)`;
    }

    // R3: Recompute totals and pooled rates from selected range points
    const totalImpr = points.reduce((acc, p) => acc + Number(p.impressions || 0), 0);
    const totalEng = points.reduce((acc, p) => acc + Number(p.engagements || 0), 0);
    const totalOut = points.reduce((acc, p) => acc + Number(p.outbound_clicks || 0), 0);
    const totalPinClicks = points.reduce((acc, p) => acc + Number(p.pin_clicks || 0), 0);
    const totalSaves = points.reduce((acc, p) => acc + Number(p.saves || 0), 0);

    const pooledEngRate = totalImpr > 0 ? totalEng / totalImpr : null;
    const pooledOutRate = totalImpr > 0 ? totalOut / totalImpr : null;
    const pooledPinClickRate = totalImpr > 0 ? totalPinClicks / totalImpr : null;
    const pooledSaveRate = totalImpr > 0 ? totalSaves / totalImpr : null;
    const pooledEr = totalImpr > 0 ? totalEng / totalImpr : 0;

    const bestRankNum = points.length > 0
      ? Math.min(...points.map(p => Number(p.rank_position) || 999999))
      : (Number(item.best_rank) || 999999);
    const bestRankDisplay = bestRankNum === 999999 ? '—' : `#${bestRankNum}`;

    // Last two timeline points (date-asc)
    const pLen = points.length;
    const lastP = pLen >= 1 ? points[pLen - 1] : null;
    const prevP = pLen >= 2 ? points[pLen - 2] : null;

    // Helper for count pct delta
    const getCountDelta = (key: string) => {
      if (!prevP || !lastP) return { text: '', type: 'none' as const };
      const vPrev = Number(prevP[key] || 0);
      const vLast = Number(lastP[key] || 0);
      if (vPrev === 0 && vLast === 0) return { text: '', type: 'none' as const };
      if (vPrev === 0) return { text: '▲ NEW', type: 'up' as const };
      const pct = ((vLast - vPrev) / vPrev) * 100;
      if (pct > 0.05) return { text: `▲ ${pct.toFixed(1)}%`, type: 'up' as const };
      if (pct < -0.05) return { text: `▼ ${Math.abs(pct).toFixed(1)}%`, type: 'down' as const };
      return { text: '', type: 'none' as const };
    };

    // 1. Best Rank Delta
    let rankDeltaInfo: { text: string; type: 'up' | 'down' | 'none' } = { text: '', type: 'none' };
    if (prevP && lastP) {
      const rPrev = Number(prevP.rank_position || 0);
      const rLast = Number(lastP.rank_position || 0);
      const rankDelta = rPrev - rLast; // lower number is better
      if (rankDelta > 0) rankDeltaInfo = { text: `▲ ${rankDelta}`, type: 'up' };
      else if (rankDelta < 0) rankDeltaInfo = { text: `▼ ${Math.abs(rankDelta)}`, type: 'down' };
    }

    // 7. Engagement Rate pp change
    let erPpInfo: { text: string; type: 'up' | 'down' | 'none' } = { text: '', type: 'none' };
    if (prevP && lastP) {
      const erPrev = Number(prevP.engagement_rate || 0);
      const erLast = Number(lastP.engagement_rate || 0);
      const pp = (erLast - erPrev) * 100;
      if (pp > 0.005) erPpInfo = { text: `▲ ${pp.toFixed(2)} pp`, type: 'up' };
      else if (pp < -0.005) erPpInfo = { text: `▼ ${Math.abs(pp).toFixed(2)} pp`, type: 'down' };
    }

    const cards = [
      {
        label: 'Best Rank',
        primary: bestRankDisplay,
        secondary: null,
        delta: rankDeltaInfo,
      },
      {
        label: 'Impressions',
        primary: formatNum(totalImpr),
        secondary: null,
        delta: getCountDelta('impressions'),
      },
      {
        label: 'Engagements',
        primary: formatNum(totalEng),
        secondary: pooledEngRate !== null ? `(${formatPct(pooledEngRate)})` : null,
        delta: getCountDelta('engagements'),
      },
      {
        label: 'Outbound',
        primary: formatNum(totalOut),
        secondary: pooledOutRate !== null ? `(${formatPct(pooledOutRate)})` : null,
        delta: getCountDelta('outbound_clicks'),
      },
      {
        label: 'Pin Clicks',
        primary: formatNum(totalPinClicks),
        secondary: pooledPinClickRate !== null ? `(${formatPct(pooledPinClickRate)})` : null,
        delta: getCountDelta('pin_clicks'),
      },
      {
        label: 'Saves',
        primary: formatNum(totalSaves),
        secondary: pooledSaveRate !== null ? `(${formatPct(pooledSaveRate)})` : null,
        delta: getCountDelta('saves'),
      },
      {
        label: 'Eng. Rate',
        primary: formatPct(pooledEr),
        secondary: null,
        delta: erPpInfo,
      },
      {
        label: 'Snapshots',
        primary: String(points.length),
        secondary: null,
        delta: { text: '', type: 'none' as const },
      },
    ];

    grid.innerHTML = cards.map(c => `
      <div class="rounded-xl border border-border bg-muted/20 p-3 flex flex-col justify-between">
        <div class="flex items-center justify-between gap-1 mb-1.5">
          <span class="text-[10px] uppercase tracking-wide text-muted-foreground font-bold">${escapeHtml(c.label)}</span>
          ${renderDeltaChip(c.delta.text, c.delta.type)}
        </div>
        <div class="mt-auto">
          <span class="text-base font-bold tabular-nums text-foreground block leading-tight">${escapeHtml(c.primary)}</span>
          ${c.secondary ? `<span class="text-[10px] text-muted-foreground block font-medium mt-0.5 leading-none">${escapeHtml(c.secondary)}</span>` : ''}
        </div>
      </div>
    `).join('');
  }

  // F2 & R2: Metric Chips & Sparkline Chart Builder with Round HTML Buttons
  function renderDrawerMetricChips() {
    const container = document.getElementById('drawer-metric-chips');
    if (!container) return;

    container.innerHTML = TREND_METRICS.map((m, idx) => {
      const isActive = idx === activeDrawerMetricIndex;
      return `
        <button
          type="button"
          data-metric-idx="${idx}"
          class="rounded-lg px-2 py-0.5 text-xs font-semibold transition-all ${
            isActive
              ? 'bg-primary text-primary-foreground shadow-sm'
              : 'border border-border/70 bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-muted'
          }"
        >
          ${escapeHtml(m.label)}
        </button>
      `;
    }).join('');

    container.querySelectorAll<HTMLButtonElement>('button[data-metric-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        activeDrawerMetricIndex = parseInt(btn.getAttribute('data-metric-idx') || '0', 10);
        renderDrawerMetricChips();
        renderDrawerSparkline();
      });
    });
  }

  function renderDrawerSparkline() {
    const container = document.getElementById('drawer-sparkline-container');
    const minLabel = document.getElementById('drawer-chart-min-label');
    const latestBadge = document.getElementById('drawer-chart-latest-badge');
    const subtitle = document.getElementById('drawer-chart-subtitle');
    const tooltip = document.getElementById('drawer-chart-tooltip');
    if (!container) return;

    const points = activeDrawerTimelinePoints;
    const metric = TREND_METRICS[activeDrawerMetricIndex] || TREND_METRICS[0];

    if (subtitle) {
      subtitle.textContent = (metric as any).invert ? '(lower is better)' : '';
    }

    if (!points || points.length === 0) {
      container.innerHTML = '<p class="text-xs text-muted-foreground">No data points available.</p>';
      if (minLabel) minLabel.textContent = '';
      if (latestBadge) latestBadge.textContent = '';
      return;
    }

    // Extract values
    const rawValues = points.map(p => Number(p[metric.key] || 0));
    const min = Math.min(...rawValues);
    const max = Math.max(...rawValues);
    const lastP = points[points.length - 1];
    const lastV = Number(lastP[metric.key] || 0);

    // Update Min/Max & Latest Badges
    if (minLabel) {
      if ((metric as any).invert) {
        minLabel.textContent = `Best: #${min} • Lowest: #${max}`;
      } else {
        minLabel.textContent = `Min: ${formatNum(min)} • Max: ${formatNum(max)}`;
      }
    }

    if (latestBadge) {
      if (metric.key === 'rank_position') {
        latestBadge.textContent = `Latest: #${lastV}`;
      } else {
        const rVal = metric.rateKey ? lastP[metric.rateKey] : null;
        latestBadge.textContent = `Latest: ${fmtMetric(lastV, rVal)}`;
      }
    }

    if (points.length === 1) {
      const tipText = `${points[0].window_end} • ${metric.label}: ${metric.key === 'rank_position' ? '#' + lastV : fmtMetric(lastV, metric.rateKey ? points[0][metric.rateKey] : null)}`;
      container.innerHTML = `
        <svg viewBox="0 0 100 40" class="w-full h-full" preserveAspectRatio="none">
          <line x1="0" y1="20" x2="100" y2="20" stroke="currentColor" class="text-primary" stroke-width="2" vector-effect="non-scaling-stroke" stroke-dasharray="4" />
        </svg>
        <button
          type="button"
          tabindex="0"
          role="button"
          aria-label="${escapeHtml(tipText)}"
          data-tip="${escapeHtml(tipText)}"
          data-x="50"
          data-y="50"
          class="chart-dot-btn absolute w-2 h-2 rounded-full bg-primary ring-2 ring-card hover:scale-150 focus:scale-150 focus:outline-none focus:ring-2 focus:ring-primary transition-transform cursor-pointer -translate-x-1/2 -translate-y-1/2 z-10"
          style="left: 50%; top: 50%;"
        ></button>
      `;
      bindDotEvents(container, tooltip);
      return;
    }

    const range = max - min || 1;
    const padX = 5;
    const padY = 8;
    const effectiveH = 40 - padY * 2;
    const effectiveW = 100 - padX * 2;

    const coords = points.map((p, idx) => {
      const v = Number(p[metric.key] || 0);
      const x = padX + (idx / (points.length - 1)) * effectiveW;
      // Invert if rank (lower value = higher Y on chart)
      const ratio = (metric as any).invert ? (max - v) / range : (v - min) / range;
      const y = 40 - padY - ratio * effectiveH;
      return { x, y, v, p, idx };
    });

    const polylinePoints = coords.map(c => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' ');
    const polygonPoints = `0,40 ${polylinePoints} 100,40`;

    // R2: Pure SVG polyline & area fill without circles
    const svgHtml = `
      <svg viewBox="0 0 100 40" class="w-full h-full overflow-visible pointer-events-none" preserveAspectRatio="none">
        <defs>
          <linearGradient id="sparkline-gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--color-primary, #6366f1)" stop-opacity="0.25" />
            <stop offset="100%" stop-color="var(--color-primary, #6366f1)" stop-opacity="0.0" />
          </linearGradient>
        </defs>
        <polygon points="${polygonPoints}" fill="url(#sparkline-gradient)" />
        <polyline
          points="${polylinePoints}"
          fill="none"
          stroke="currentColor"
          class="text-primary"
          stroke-width="2"
          vector-effect="non-scaling-stroke"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    `;

    // R2: HTML button dots absolutely positioned over the chart wrapper
    const dotsHtml = coords.map(c => {
      const r = metric.rateKey ? c.p[metric.rateKey] : null;
      const valStr = metric.key === 'rank_position' ? `#${c.v}` : fmtMetric(c.v, r);
      const tipText = `${c.p.window_end} • ${metric.label}: ${valStr}`;

      return `
        <button
          type="button"
          tabindex="0"
          role="button"
          aria-label="${escapeHtml(tipText)}"
          data-tip="${escapeHtml(tipText)}"
          data-x="${c.x.toFixed(2)}"
          data-y="${c.y.toFixed(2)}"
          class="chart-dot-btn absolute w-2 h-2 rounded-full bg-primary ring-2 ring-card hover:scale-150 focus:scale-150 focus:outline-none focus:ring-2 focus:ring-primary transition-transform cursor-pointer -translate-x-1/2 -translate-y-1/2 z-10"
          style="left: ${c.x.toFixed(2)}%; top: ${c.y.toFixed(2)}%;"
        ></button>
      `;
    }).join('');

    container.innerHTML = svgHtml + dotsHtml;
    bindDotEvents(container, tooltip);
  }

  function bindDotEvents(container: HTMLElement, tooltip: HTMLElement | null) {
    const showTip = (el: Element) => {
      if (!tooltip) return;
      const text = el.getAttribute('data-tip');
      const x = parseFloat(el.getAttribute('data-x') || '0');
      const y = parseFloat(el.getAttribute('data-y') || '0');
      if (text) {
        tooltip.textContent = text;
        tooltip.style.left = `${x}%`;
        tooltip.style.top = `${y}%`;
        tooltip.classList.remove('hidden');
      }
    };

    const hideTip = () => {
      if (tooltip) tooltip.classList.add('hidden');
    };

    container.querySelectorAll('.chart-dot-btn').forEach(btn => {
      btn.addEventListener('mouseenter', () => showTip(btn));
      btn.addEventListener('mouseleave', hideTip);
      btn.addEventListener('focus', () => showTip(btn));
      btn.addEventListener('blur', hideTip);
      btn.addEventListener('keydown', (e: any) => {
        if (e.key === 'Escape') hideTip();
      });
    });
  }

  // F3 & F4: Timeline Drawer Open/Close & History Table
  async function openTimelineDrawer(item: any) {
    if (!drawer) return;
    activeDrawerPin = item;

    // Header values
    const titleEl = document.getElementById('drawer-pin-title');
    const idEl = document.getElementById('drawer-pin-id');
    const imgEl = document.getElementById('drawer-pin-image') as HTMLImageElement;
    const linkEl = document.getElementById('drawer-pin-link') as HTMLAnchorElement;
    const windowNotice = document.getElementById('drawer-window-notice');

    if (titleEl) titleEl.textContent = item.title || `Pin #${item.pin_id}`;
    if (idEl) idEl.textContent = item.pin_id;
    if (windowNotice) windowNotice.textContent = `Totals (${activeDrawerDays}D)`;

    const pLink = item.destination_url || `https://www.pinterest.com/pin/${item.pin_id}/`;
    if (linkEl) linkEl.href = pLink;

    if (imgEl) {
      if (item.image_url) {
        imgEl.src = item.image_url;
        imgEl.classList.remove('hidden');
      } else {
        imgEl.classList.add('hidden');
      }
    }

    // Open drawer
    drawer.classList.remove('translate-x-full');
    drawer.classList.add('translate-x-0');
    if (drawerBackdrop) {
      drawerBackdrop.classList.remove('opacity-0', 'pointer-events-none');
      drawerBackdrop.classList.add('opacity-100', 'pointer-events-auto');
    }

    // Focus close button for accessibility
    drawerCloseBtn?.focus();

    await loadDrawerTimelineData();
  }

  async function loadDrawerTimelineData() {
    if (!activeDrawerPin) return;

    const mainContent = document.getElementById('drawer-main-content');
    const stateContainer = document.getElementById('drawer-state-container');
    const historyTbody = document.getElementById('drawer-history-tbody');
    const sparklineEl = document.getElementById('drawer-sparkline-container');

    // Loading skeleton in table and sparkline
    if (historyTbody) {
      historyTbody.innerHTML = `
        <tr>
          <td colspan="7" class="py-8 text-center text-xs text-muted-foreground animate-pulse">
            Loading timeline history...
          </td>
        </tr>
      `;
    }
    if (sparklineEl) {
      sparklineEl.innerHTML = '<div class="text-xs text-muted-foreground animate-pulse">Loading trend curve...</div>';
    }

    try {
      const res = await fetch(`/api/analytics/connections/${intelConnId}/pin-trends?pin_id=${activeDrawerPin.pin_id}&sort_by=${state.mode}&days=${activeDrawerDays}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to fetch pin trends`);
      const json = await res.json();
      activeDrawerTimelinePoints = json.data || [];

      if (mainContent) mainContent.classList.remove('hidden');
      if (stateContainer) stateContainer.classList.add('hidden');

      // R1 & R3: Render 8 Stat Cards
      renderDrawerStatCards(activeDrawerPin, activeDrawerTimelinePoints);

      // R2: Render Metric Chips & Sparkline
      renderDrawerMetricChips();
      renderDrawerSparkline();

      // F3: Render Sticky Table Rows (descending by date)
      if (historyTbody) {
        if (activeDrawerTimelinePoints.length === 0) {
          historyTbody.innerHTML = `
            <tr>
              <td colspan="7" class="py-8 text-center text-xs text-muted-foreground">
                No snapshots found for this pin in the last ${activeDrawerDays} days.
              </td>
            </tr>
          `;
          return;
        }

        const sortedDesc = [...activeDrawerTimelinePoints].reverse();
        historyTbody.innerHTML = sortedDesc.map((p: any) => {
          return `
            <tr class="hover:bg-muted/20 border-b border-border/50 text-xs">
              <td class="py-2.5 px-3 font-mono text-muted-foreground">${escapeHtml(p.window_end)}</td>
              <td class="py-2.5 px-3 font-bold text-center">#${p.rank_position}</td>
              <td class="py-2.5 px-3 text-right font-medium tabular-nums">${formatNum(p.impressions)}</td>
              <td class="py-2.5 px-3 text-right font-medium tabular-nums">${fmtMetric(p.engagements, p.engagement_rate)}</td>
              <td class="py-2.5 px-3 text-right font-medium tabular-nums">${fmtMetric(p.outbound_clicks, p.outbound_click_rate)}</td>
              <td class="py-2.5 px-3 text-right font-medium tabular-nums">${fmtMetric(p.pin_clicks, p.pin_click_rate)}</td>
              <td class="py-2.5 px-3 text-right font-medium tabular-nums">${fmtMetric(p.saves, p.save_rate)}</td>
            </tr>
          `;
        }).join('');
      }

    } catch (e: any) {
      console.error('[Drawer] Error loading pin trends:', e);
      if (sparklineEl) sparklineEl.innerHTML = '<p class="text-xs text-rose-500">Failed to render sparkline</p>';
      if (historyTbody) {
        historyTbody.innerHTML = `
          <tr>
            <td colspan="7" class="py-6 text-center text-xs text-rose-500">
              ${escapeHtml(e.message) || 'Error loading timeline records.'}
              <button id="drawer-retry-btn" class="mt-2 block mx-auto rounded bg-primary px-2.5 py-1 text-xs text-primary-foreground">Retry</button>
            </td>
          </tr>
        `;
        document.getElementById('drawer-retry-btn')?.addEventListener('click', loadDrawerTimelineData);
      }
    }
  }

  function closeTimelineDrawer() {
    if (!drawer) return;
    drawer.classList.remove('translate-x-0');
    drawer.classList.add('translate-x-full');
    if (drawerBackdrop) {
      drawerBackdrop.classList.remove('opacity-100', 'pointer-events-auto');
      drawerBackdrop.classList.add('opacity-0', 'pointer-events-none');
    }
    // Return focus to originating leaderboard row
    if (lastActiveLeaderboardRow) {
      lastActiveLeaderboardRow.focus();
    }
  }

  // Bind close drawer buttons
  drawerCloseBtn?.addEventListener('click', closeTimelineDrawer);
  drawerBackdrop?.addEventListener('click', closeTimelineDrawer);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer && !drawer.classList.contains('translate-x-full')) {
      closeTimelineDrawer();
    }
  });

  // Bind Drawer Range Presets
  document.querySelectorAll('#drawer-range-presets button[data-drawer-days]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#drawer-range-presets button[data-drawer-days]').forEach(b => {
        b.className = 'drawer-preset-btn rounded-lg px-2 py-0.5 text-xs font-semibold text-muted-foreground hover:text-foreground transition-all';
      });
      btn.className = 'drawer-preset-btn active rounded-lg bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground shadow-sm transition-all';
      activeDrawerDays = parseInt(btn.getAttribute('data-drawer-days') || '90', 10);
      loadDrawerTimelineData();
    });
  });

  // Bind Copy ID button
  const copyIdBtn = document.getElementById('drawer-copy-id-btn');
  copyIdBtn?.addEventListener('click', async () => {
    if (activeDrawerPin?.pin_id) {
      try {
        await navigator.clipboard.writeText(String(activeDrawerPin.pin_id));
        const originalHtml = copyIdBtn.innerHTML;
        copyIdBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`;
        setTimeout(() => {
          copyIdBtn.innerHTML = originalHtml;
        }, 1500);
      } catch (err) {
        console.error('Failed to copy ID', err);
      }
    }
  });

  // Bind Drawer Timeline CSV Export
  const drawerExportCsvBtn = document.getElementById('drawer-export-csv-btn');
  drawerExportCsvBtn?.addEventListener('click', () => {
    if (!activeDrawerTimelinePoints || activeDrawerTimelinePoints.length === 0) {
      alert('No history records available to export.');
      return;
    }

    const headers = [
      'date',
      'rank',
      'impressions',
      'engagements',
      'engagement_rate',
      'outbound_clicks',
      'outbound_click_rate',
      'pin_clicks',
      'pin_click_rate',
      'saves',
      'save_rate',
    ];

    const csvRows = [headers.join(',')];

    for (const p of activeDrawerTimelinePoints) {
      const row = [
        `"${p.window_end || ''}"`,
        p.rank_position || 0,
        p.impressions || 0,
        p.engagements || 0,
        `"${formatPct(p.engagement_rate)}"`,
        p.outbound_clicks || 0,
        `"${formatPct(p.outbound_click_rate)}"`,
        p.pin_clicks || 0,
        `"${formatPct(p.pin_click_rate)}"`,
        p.saves || 0,
        `"${formatPct(p.save_rate)}"`,
      ];
      csvRows.push(row.join(','));
    }

    const csvBlob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const filename = `pin_${activeDrawerPin?.pin_id || 'unknown'}_timeline_${activeDrawerDays}d.csv`;
    const link = document.createElement('a');
    const url = URL.createObjectURL(csvBlob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  });

  // Bind Sort Mode tabs
  document.querySelectorAll('#intel-sort-tabs button[data-intel-sort]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#intel-sort-tabs button[data-intel-sort]').forEach(b => {
        b.className = 'mode-tab rounded-lg px-3 py-1 text-xs font-semibold text-muted-foreground transition-all hover:text-foreground';
      });
      btn.className = 'mode-tab active rounded-lg bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground shadow-sm transition-all';
      state.mode = btn.getAttribute('data-intel-sort') || 'IMPRESSION';
      state.page = 1;
      loadPinLeaderboard();
    });
  });

  // Bind Range presets
  document.querySelectorAll('#intel-range-presets button[data-intel-days]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#intel-range-presets button[data-intel-days]').forEach(b => {
        b.className = 'preset-btn rounded-lg px-2.5 py-0.5 text-xs font-semibold text-muted-foreground hover:text-foreground transition-all';
      });
      btn.className = 'preset-btn active rounded-lg bg-primary px-2.5 py-0.5 text-xs font-semibold text-primary-foreground shadow-sm transition-all';
      state.days = parseInt(btn.getAttribute('data-intel-days') || '30', 10);
      state.page = 1;
      loadPinLeaderboard();
    });
  });

  // Bind Search box
  const searchInput = document.getElementById('intel-search') as HTMLInputElement;
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        state.search = searchInput.value.trim();
        state.page = 1;
        loadPinLeaderboard();
      }, 300);
    });
  }

  // Bind Filter Apply & Clear buttons
  const applyBtn = document.getElementById('intel-apply-filters-btn');
  if (applyBtn) {
    applyBtn.addEventListener('click', () => {
      const minImprInput = document.getElementById('intel-min-impr') as HTMLInputElement;
      const minAppInput = document.getElementById('intel-min-app') as HTMLInputElement;
      const trendSelect = document.getElementById('intel-trend-filter') as HTMLSelectElement;
      const linkSelect = document.getElementById('intel-link-filter') as HTMLSelectElement;

      state.minImpressions = minImprInput?.value.trim() || '';
      state.minAppearances = minAppInput?.value.trim() || '';
      state.trend = trendSelect?.value || 'ALL';
      state.hasLink = linkSelect?.value || '';
      state.page = 1;
      loadPinLeaderboard();
    });
  }

  const clearBtn = document.getElementById('intel-clear-filters-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      const minImprInput = document.getElementById('intel-min-impr') as HTMLInputElement;
      const minAppInput = document.getElementById('intel-min-app') as HTMLInputElement;
      const trendSelect = document.getElementById('intel-trend-filter') as HTMLSelectElement;
      const linkSelect = document.getElementById('intel-link-filter') as HTMLSelectElement;

      if (minImprInput) minImprInput.value = '';
      if (minAppInput) minAppInput.value = '';
      if (trendSelect) trendSelect.value = 'ALL';
      if (linkSelect) linkSelect.value = '';

      state.minImpressions = '';
      state.minAppearances = '';
      state.trend = 'ALL';
      state.hasLink = '';
      state.page = 1;
      loadPinLeaderboard();
    });
  }

  // Bind Sortable Column Headers
  document.querySelectorAll<HTMLElement>('th[data-intel-col]').forEach(th => {
    const colName = th.getAttribute('data-intel-col');
    if (colName && colName !== '#' && colName !== 'pin' && colName !== 'trend') {
      th.addEventListener('click', () => {
        if (state.sort === colName) {
          state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
        } else {
          state.sort = colName;
          state.sortDir = colName === 'best_rank' ? 'asc' : 'desc';
        }
        state.page = 1;
        loadPinLeaderboard();
      });
    }
  });

  // Bind Page Size selector
  const psSelect = document.getElementById('intel-ps') as HTMLSelectElement;
  if (psSelect) {
    psSelect.addEventListener('change', () => {
      state.pageSize = parseInt(psSelect.value, 10) || 25;
      state.page = 1;
      loadPinLeaderboard();
    });
  }

  // Bind Column Visibility Dropdown
  const colBtn = document.getElementById('intel-col-btn');
  const colMenu = document.getElementById('intel-col-menu');

  colBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    colMenu?.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (colMenu && !colMenu.contains(e.target as Node) && !colBtn?.contains(e.target as Node)) {
      colMenu.classList.add('hidden');
    }
  });

  colMenu?.querySelectorAll<HTMLInputElement>('input[data-col]').forEach(cb => {
    cb.addEventListener('change', () => {
      const colName = cb.getAttribute('data-col');
      if (colName) {
        const visibleCols = getVisibleColumns();
        visibleCols[colName] = cb.checked;
        saveVisibleColumns(visibleCols);
        applyColumnVisibility();
      }
    });
  });

  // Bind CSV Export Button (Leaderboard)
  const exportCsvBtn = document.getElementById('intel-export-csv-btn');
  if (exportCsvBtn) {
    exportCsvBtn.addEventListener('click', () => {
      if (!currentItems || currentItems.length === 0) {
        alert('No data available to export.');
        return;
      }

      const headers = [
        'Pin ID',
        'Title',
        'Destination URL',
        'Appearances',
        'Best Rank',
        'Total Impressions',
        'Total Engagements',
        'Engagement Rate',
        'Total Outbound Clicks',
        'Outbound Click Rate',
        'Total Pin Clicks',
        'Pin Click Rate',
        'Total Saves',
        'Save Rate',
        'Last Seen',
        'Trend',
      ];

      const csvRows = [headers.join(',')];

      for (const item of currentItems) {
        const row = [
          `"${String(item.pin_id || '').replace(/"/g, '""')}"`,
          `"${String(item.title || '').replace(/"/g, '""')}"`,
          `"${String(item.destination_url || '').replace(/"/g, '""')}"`,
          item.appearances || 0,
          item.best_rank || 0,
          item.total_impressions || 0,
          item.total_engagements || 0,
          `"${formatPct(item.engagement_rate)}"`,
          item.total_outbound_clicks || 0,
          `"${formatPct(item.outbound_click_rate)}"`,
          item.total_pin_clicks || 0,
          `"${formatPct(item.pin_click_rate)}"`,
          item.total_saves || 0,
          `"${formatPct(item.save_rate)}"`,
          `"${item.last_seen || ''}"`,
          `"${item.trend || ''}"`,
        ];
        csvRows.push(row.join(','));
      }

      const csvBlob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const filename = `pin-intelligence_${state.mode.toLowerCase()}_${state.days}d.csv`;
      const link = document.createElement('a');
      const url = URL.createObjectURL(csvBlob);
      link.setAttribute('href', url);
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    });
  }

  // Load when intelligence tab is opened
  loadStateFromUrl();
  applyColumnVisibility();

  document.querySelectorAll('[role="tab"]').forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.getAttribute('data-tab') === 'intelligence') {
        hasLoadedIntel = true;
        loadPinLeaderboard();
      }
    });
  });

  if (window.location.hash === '#intelligence' || window.location.hash === '#intel') {
    hasLoadedIntel = true;
    loadPinLeaderboard();
  }

  window.addEventListener('analytics:data-purged', () => {
    if (hasLoadedIntel) {
      loadPinLeaderboard();
    }
  });
}
