    let watches = [];
    let selectedId = null;
    let selectedData = null;
    let editingId = null;
    let onlyMatches = false;

    const $ = id => document.getElementById(id);
    const apiHeaders = { 'Content-Type': 'application/json' };

    for (let hour = 0; hour < 24; hour++) {
      const option = document.createElement('option');
      option.value = String(hour);
      option.textContent = `${String(hour).padStart(2, '0')}:00`;
      $('preferredHour').appendChild(option);
    }
    $('preferredHour').insertBefore(new Option('Ingen præference', ''), $('preferredHour').firstChild);
    $('preferredHour').value = '';

    function escapeHtml(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
    }

    function formatPrice(price) {
      return price == null ? 'Pris ukendt' : `${new Intl.NumberFormat('da-DK').format(price)} kr.`;
    }

    function formatDate(timestamp) {
      return timestamp ? new Date(timestamp).toLocaleString('da-DK') : 'Aldrig';
    }

    function conditionLabel(condition) {
      return { new: 'Ny', demo: 'Demo', refurb: 'Refurbished', 'open-box': 'Open box', returned: 'Retur', used: 'Brugt' }[condition] || '';
    }

    function dealLabel(deal) {
      if (deal.reason === 'on_page_discount') return `${deal.discountPercent}% rabat mod normalpris`;
      if (deal.reason === 'historic_low') return 'Historisk lavpris';
      return 'Nær historisk lavpris';
    }

    function truncate(text, max) {
      const value = String(text ?? '');
      return value.length > max ? `${value.slice(0, max - 1)}…` : value;
    }

    function setStatus(element, message, error = false) {
      element.textContent = message || '';
      element.classList.toggle('error', error);
    }

    async function api(path, options = {}) {
      const response = await fetch(path, { ...options, headers: { ...apiHeaders, ...(options.headers || {}) } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Serverfejl ${response.status}`);
      return data;
    }

    function formPayload() {
      return {
        name: $('name').value.trim(),
        adapter: 'webwatch',
        criteria: $('criteria').value.trim(),
        keyword: $('keyword').value.trim() || null,
        maxPrice: $('maxPrice').value || null,
        minDiscountPercent: $('minDiscountPercent').value || null,
        interval: $('interval').value,
        preferredHour: $('preferredHour').value || null,
      };
    }

    function enterEditMode(watch) {
      editingId = watch.id;
      $('name').value = watch.name;
      $('criteria').value = watch.criteria || '';
      $('keyword').value = watch.keyword || '';
      $('maxPrice').value = watch.maxPrice ?? '';
      $('minDiscountPercent').value = watch.minDiscountPercent ?? '';
      $('interval').value = watch.interval;
      $('preferredHour').value = watch.preferredHour ?? '';
      $('formTitle').textContent = `Rediger “${watch.name}”`;
      $('createBtn').textContent = 'Gem ændringer';
      $('cancelEditBtn').hidden = false;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function exitEditMode() {
      editingId = null;
      $('createForm').reset();
      $('preferredHour').value = '';
      $('formTitle').textContent = 'Ny web watch';
      $('createBtn').textContent = 'Opret web watch';
      $('cancelEditBtn').hidden = true;
    }

    $('cancelEditBtn').addEventListener('click', exitEditMode);

    $('createForm').addEventListener('submit', async event => {
      event.preventDefault();
      const button = $('createBtn');
      button.disabled = true;
      setStatus($('createStatus'), editingId ? 'Gemmer…' : 'Opretter…');
      try {
        if (editingId) {
          const watch = await api(`/api/itemwatch/${encodeURIComponent(editingId)}`, {
            method: 'PATCH',
            body: JSON.stringify(formPayload()),
          });
          setStatus($('createStatus'), 'Gemt.');
          exitEditMode();
          await loadWatches();
          await selectWatch(watch.id, false);
        } else {
          const watch = await api('/api/itemwatch', { method: 'POST', body: JSON.stringify(formPayload()) });
          setStatus($('createStatus'), 'Oprettet. Kør den for at lave første baseline.');
          $('createForm').reset();
          $('preferredHour').value = '';
          await loadWatches();
          await selectWatch(watch.id);
        }
      } catch (error) {
        setStatus($('createStatus'), error.message, true);
      } finally {
        button.disabled = false;
      }
    });

    $('refreshBtn').addEventListener('click', loadWatches);
    $('runBtn').addEventListener('click', runSelected);
    $('editBtn').addEventListener('click', () => selectedData && enterEditMode(selectedData.watch));
    $('toggleBtn').addEventListener('click', toggleSelected);
    $('deleteBtn').addEventListener('click', deleteSelected);
    $('onlyMatchesToggle').addEventListener('change', event => {
      onlyMatches = event.target.checked;
      if (selectedData) renderDetail();
    });

    async function loadWatches() {
      setStatus($('listStatus'), 'Henter…');
      try {
        watches = (await api('/api/itemwatch')).filter(watch => watch.adapter === 'webwatch');
        renderWatches();
        setStatus($('listStatus'), watches.length ? '' : 'Ingen web watches endnu.');
        if (selectedId && watches.some(watch => watch.id === selectedId)) await selectWatch(selectedId, false);
      } catch (error) {
        setStatus($('listStatus'), error.message, true);
      }
    }

    function renderWatches() {
      $('watchList').innerHTML = watches.map(watch => {
        const deals = watch.lastDeals || [];
        return `
          <article class="profile ${watch.id === selectedId ? 'selected' : ''}" data-watch-id="${escapeHtml(watch.id)}">
            <div class="profile-head">
              <div class="profile-name">${escapeHtml(watch.name)}</div>
              ${watch.enabled ? '' : '<span class="pill paused">Pause</span>'}
            </div>
            <div class="profile-meta">${escapeHtml(truncate(watch.criteria, 80))}</div>
            <div class="profile-meta">Senest: ${escapeHtml(formatDate(watch.lastRun))}</div>
            ${watch.lastError ? `<div class="profile-meta" style="color:var(--red)">${escapeHtml(watch.lastError)}</div>` : ''}
            <div class="stats">
              <span class="pill drop">${deals.length} fund</span>
            </div>
          </article>`;
      }).join('');
      document.querySelectorAll('[data-watch-id]').forEach(element => {
        element.addEventListener('click', () => selectWatch(element.dataset.watchId));
      });
    }

    async function selectWatch(id, scroll = true) {
      if (editingId && editingId !== id) exitEditMode();
      if (id !== selectedId) {
        onlyMatches = false;
        $('onlyMatchesToggle').checked = false;
      }
      selectedId = id;
      renderWatches();
      $('detailCard').hidden = false;
      setStatus($('detailStatus'), 'Henter…');
      try {
        selectedData = await api(`/api/itemwatch/${encodeURIComponent(id)}`);
        renderDetail();
        setStatus($('detailStatus'), selectedData.watch.lastError || '', Boolean(selectedData.watch.lastError));
        if (scroll && window.innerWidth < 760) $('detailCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (error) {
        setStatus($('detailStatus'), error.message, true);
      }
    }

    function scheduleLabel(watch) {
      const interval = watch.interval === 'weekly' ? 'Ugentligt' : 'Dagligt';
      const hour = watch.preferredHour == null ? '' : ` omkring ${String(watch.preferredHour).padStart(2, '0')}:00 UTC`;
      return interval + hour;
    }

    function renderDetail() {
      const { watch, state } = selectedData;
      $('detailName').textContent = watch.name;
      $('detailMeta').textContent = `${watch.criteria}${watch.keyword ? ` · “${watch.keyword}”` : ''} · Maks. ${watch.maxPrice == null ? 'ikke sat' : formatPrice(watch.maxPrice)} · Min. rabat ${watch.minDiscountPercent == null ? 'ikke sat' : watch.minDiscountPercent + '%'} · ${scheduleLabel(watch)} · Senest ${formatDate(watch.lastRun)}`;
      $('toggleBtn').textContent = watch.enabled ? 'Sæt på pause' : 'Aktivér';

      const products = Object.values(state?.products || {});
      const deals = watch.lastDeals || [];
      $('detailStats').innerHTML = `
        <span class="pill">${products.length} produkter sporet</span>
        <span class="pill drop">${deals.length} fund ved seneste kørsel</span>`;

      renderProducts(products, deals);
    }

    function renderProducts(products, deals) {
      if (!products.length) {
        $('productList').innerHTML = '<div class="empty">Kør web watch for at oprette en baseline.</div>';
        return;
      }
      const dealByProduct = new Map(deals.map(deal => [deal.productId, deal]));
      const matches = [];
      const rest = [];
      for (const product of products) (dealByProduct.has(product.id) ? matches : rest).push(product);
      matches.sort((a, b) =>
        (dealByProduct.get(b.id).discountPercent || 0) - (dealByProduct.get(a.id).discountPercent || 0)
        || a.price - b.price);
      rest.sort((a, b) => a.price - b.price);
      const visible = onlyMatches ? matches : [...matches, ...rest];

      if (!visible.length) {
        $('productList').innerHTML = '<div class="empty">Ingen fund ved seneste kørsel.</div>';
        return;
      }

      $('productList').innerHTML = visible.map(product => {
        const deal = dealByProduct.get(product.id);
        const historicLow = product.history.length ? Math.min(...product.history.map(point => point.price)) : null;
        return `
          <article class="listing ${deal ? 'deal' : ''}">
            <div class="listing-top">
              <div class="listing-title">
                <a href="${escapeHtml(product.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(product.name)}</a>
                <div class="listing-meta">
                  ${product.condition ? `${escapeHtml(conditionLabel(product.condition))} · ` : ''}
                  ${escapeHtml(new URL(product.url).hostname)} · Historisk lav: ${escapeHtml(formatPrice(historicLow))}
                  ${deal ? ` · <span style="color:var(--green)">${escapeHtml(dealLabel(deal))}</span>` : ''}
                </div>
              </div>
              <div class="price">
                ${product.originalPrice != null ? `<div class="old-price">${escapeHtml(formatPrice(product.originalPrice))}</div>` : ''}
                ${escapeHtml(formatPrice(product.price))}
              </div>
            </div>
          </article>`;
      }).join('');
    }

    async function runSelected() {
      if (!selectedId) return;
      const button = $('runBtn');
      button.disabled = true;
      setStatus($('detailStatus'), 'Genererer søgninger, læser resultater og sammenligner priser… dette kan tage lidt tid.');
      try {
        await api(`/api/itemwatch/${encodeURIComponent(selectedId)}/run`, { method: 'POST', body: '{}' });
        await loadWatches();
        await selectWatch(selectedId, false);
        setStatus($('detailStatus'), 'Kørsel gennemført.');
      } catch (error) {
        setStatus($('detailStatus'), error.message, true);
      } finally {
        button.disabled = false;
      }
    }

    async function toggleSelected() {
      if (!selectedData) return;
      try {
        await api(`/api/itemwatch/${encodeURIComponent(selectedId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: !selectedData.watch.enabled }),
        });
        await loadWatches();
        await selectWatch(selectedId, false);
      } catch (error) {
        setStatus($('detailStatus'), error.message, true);
      }
    }

    async function deleteSelected() {
      if (!selectedData || !confirm(`Slet web watch “${selectedData.watch.name}”?`)) return;
      try {
        await api(`/api/itemwatch/${encodeURIComponent(selectedId)}`, { method: 'DELETE' });
        if (editingId === selectedId) exitEditMode();
        selectedId = null;
        selectedData = null;
        $('detailCard').hidden = true;
        await loadWatches();
      } catch (error) {
        setStatus($('detailStatus'), error.message, true);
      }
    }

    loadWatches();
