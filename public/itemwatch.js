    let watches = [];
    let selectedId = null;
    let selectedData = null;

    const $ = id => document.getElementById(id);
    const apiHeaders = { 'Content-Type': 'application/json' };

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

    function adapterLabel(adapter) {
      return adapter === 'maxgaming' ? 'MaxGaming.dk' : adapter;
    }

    function conditionLabel(condition) {
      return { new: 'Ny', demo: 'Demo', refurb: 'Refurbished', 'open-box': 'Open box', returned: 'Retur' }[condition] || '';
    }

    function dealLabel(reason) {
      return reason === 'historic_low' ? 'Historisk lavpris' : 'Nær historisk lavpris';
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

    $('createForm').addEventListener('submit', async event => {
      event.preventDefault();
      const button = $('createBtn');
      button.disabled = true;
      setStatus($('createStatus'), 'Opretter…');
      try {
        const watch = await api('/api/itemwatch', {
          method: 'POST',
          body: JSON.stringify({
            name: $('name').value.trim(),
            adapter: $('adapter').value,
            url: $('url').value.trim(),
            maxPrice: $('maxPrice').value || null,
          }),
        });
        setStatus($('createStatus'), 'Oprettet. Kør den for at lave første baseline.');
        $('createForm').reset();
        await loadWatches();
        await selectWatch(watch.id);
      } catch (error) {
        setStatus($('createStatus'), error.message, true);
      } finally {
        button.disabled = false;
      }
    });

    $('refreshBtn').addEventListener('click', loadWatches);
    $('runBtn').addEventListener('click', runSelected);
    $('toggleBtn').addEventListener('click', toggleSelected);
    $('deleteBtn').addEventListener('click', deleteSelected);

    async function loadWatches() {
      setStatus($('listStatus'), 'Henter…');
      try {
        watches = await api('/api/itemwatch');
        renderWatches();
        setStatus($('listStatus'), watches.length ? '' : 'Ingen item watches endnu.');
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
            <div class="profile-meta">${escapeHtml(adapterLabel(watch.adapter))}</div>
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

    function renderDetail() {
      const { watch, state } = selectedData;
      $('detailName').textContent = watch.name;
      $('detailMeta').textContent = `${adapterLabel(watch.adapter)} · Maks. ${watch.maxPrice == null ? 'ikke sat' : formatPrice(watch.maxPrice)} · Senest ${formatDate(watch.lastRun)}`;
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
        $('productList').innerHTML = '<div class="empty">Kør item watch for at oprette en baseline.</div>';
        return;
      }
      const dealByProduct = new Map(deals.map(deal => [deal.productId, deal]));
      const sorted = [...products].sort((a, b) => a.price - b.price);

      $('productList').innerHTML = sorted.map(product => {
        const deal = dealByProduct.get(product.id);
        const historicLow = product.history.length ? Math.min(...product.history.map(point => point.price)) : null;
        return `
          <article class="listing ${deal ? 'deal' : ''}">
            <div class="listing-top">
              <div class="listing-title">
                <a href="${escapeHtml(product.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(product.name)}</a>
                <div class="listing-meta">
                  ${product.condition ? `${escapeHtml(conditionLabel(product.condition))} · ` : ''}Historisk lav: ${escapeHtml(formatPrice(historicLow))}
                  ${deal ? ` · <span style="color:var(--green)">${escapeHtml(dealLabel(deal.reason))}</span>` : ''}
                </div>
              </div>
              <div class="price">${escapeHtml(formatPrice(product.price))}</div>
            </div>
          </article>`;
      }).join('');
    }

    async function runSelected() {
      if (!selectedId) return;
      const button = $('runBtn');
      button.disabled = true;
      setStatus($('detailStatus'), 'Henter siden og sammenligner priser…');
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
      if (!selectedData || !confirm(`Slet item watch “${selectedData.watch.name}”?`)) return;
      try {
        await api(`/api/itemwatch/${encodeURIComponent(selectedId)}`, { method: 'DELETE' });
        selectedId = null;
        selectedData = null;
        $('detailCard').hidden = true;
        await loadWatches();
      } catch (error) {
        setStatus($('detailStatus'), error.message, true);
      }
    }

    loadWatches();
