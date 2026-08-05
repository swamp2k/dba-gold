    const MOTORCYCLE_CRITERIA = `Prioritér lette adventure- og dual-sport-motorcykler med oprejst kørestilling, indsprøjtning og rimelige grusegenskaber. Motorcyklen skal lejlighedsvis kunne bruges med passager, både et barn og en voksen, så bagsædeplads, passagerfodhvilere og afstand mellem fører og passager vægtes højt. Foretræk lav vægt og ABS. Nedprioritér karburator, meget kompakte bagsæder, tunge modeller, projekter, defekte motorcykler og annoncer uden afgift. Relevante modeller omfatter blandt andet BMW G 310 GS, Voge 300 Rally, Yamaha XT660R og Honda Transalp 700, men gode alternativer må gerne foreslås. Vær tydelig om oplysninger, som ikke kan afgøres ud fra annoncenes titel og pris.`;

    let profiles = [];
    let selectedId = null;
    let selectedData = null;
    let activeFilter = 'active';

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

    function modelLabel(model) {
      if (model === 'claude-opus-4-8') return 'Opus 4.8';
      if (model === 'claude-sonnet-4-6') return 'Sonnet 4.6';
      return 'Haiku 4.5';
    }

    function changeLabel(change) {
      return {
        new: 'Ny', returned: 'Tilbage', price_drop: 'Prisfald', price_increase: 'Prisstigning',
        unchanged: 'Uændret', removed: 'Forsvundet'
      }[change] || change;
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

    $('motorcycleTemplate').addEventListener('click', () => {
      $('name').value = 'Motorcykeljagten';
      $('criteria').value = MOTORCYCLE_CRITERIA;
      $('maxPrice').value = '45000';
      $('model').value = 'claude-sonnet-4-6';
      $('url').focus();
    });

    $('createForm').addEventListener('submit', async event => {
      event.preventDefault();
      const button = $('createBtn');
      button.disabled = true;
      setStatus($('createStatus'), 'Opretter…');
      try {
        const profile = await api('/api/watchlists', {
          method: 'POST',
          body: JSON.stringify({
            name: $('name').value.trim(),
            url: $('url').value.trim(),
            criteria: $('criteria').value.trim(),
            maxPrice: $('maxPrice').value || null,
            interval: $('interval').value,
            model: $('model').value,
          }),
        });
        setStatus($('createStatus'), 'Oprettet. Kør profilen for at lave første baseline.');
        $('createForm').reset();
        await loadProfiles();
        await selectProfile(profile.id);
      } catch (error) {
        setStatus($('createStatus'), error.message, true);
      } finally {
        button.disabled = false;
      }
    });

    $('refreshBtn').addEventListener('click', loadProfiles);
    $('runBtn').addEventListener('click', runSelected);
    $('toggleBtn').addEventListener('click', toggleSelected);
    $('deleteBtn').addEventListener('click', deleteSelected);

    async function loadProfiles() {
      setStatus($('listStatus'), 'Henter…');
      try {
        profiles = await api('/api/watchlists');
        renderProfiles();
        setStatus($('listStatus'), profiles.length ? '' : 'Ingen profiler endnu.');
        if (selectedId && profiles.some(profile => profile.id === selectedId)) await selectProfile(selectedId, false);
      } catch (error) {
        setStatus($('listStatus'), error.message, true);
      }
    }

    function renderProfiles() {
      $('profileList').innerHTML = profiles.map(profile => {
        const summary = profile.lastSummary || {};
        return `
          <article class="profile ${profile.id === selectedId ? 'selected' : ''}" data-profile-id="${escapeHtml(profile.id)}">
            <div class="profile-head">
              <div class="profile-name">${escapeHtml(profile.name)}</div>
              ${profile.enabled ? '' : '<span class="pill paused">Pause</span>'}
            </div>
            <div class="profile-meta">${escapeHtml(profile.interval === 'weekly' ? 'Ugentlig' : 'Daglig')} · ${escapeHtml(modelLabel(profile.model))}</div>
            <div class="profile-meta">Senest: ${escapeHtml(formatDate(profile.lastRun))}</div>
            ${profile.lastError ? `<div class="profile-meta" style="color:var(--red)">${escapeHtml(profile.lastError)}</div>` : ''}
            <div class="stats">
              <span class="pill">${summary.totalActive ?? 0} aktive</span>
              <span class="pill new">${summary.newCount ?? 0} nye</span>
              <span class="pill drop">${summary.priceDropCount ?? 0} prisfald</span>
            </div>
          </article>`;
      }).join('');
      document.querySelectorAll('[data-profile-id]').forEach(element => {
        element.addEventListener('click', () => selectProfile(element.dataset.profileId));
      });
    }

    async function selectProfile(id, scroll = true) {
      selectedId = id;
      renderProfiles();
      $('detailCard').hidden = false;
      setStatus($('detailStatus'), 'Henter profil…');
      try {
        selectedData = await api(`/api/watchlists/${encodeURIComponent(id)}`);
        renderDetail();
        setStatus($('detailStatus'), selectedData.profile.lastError || '', Boolean(selectedData.profile.lastError));
        if (scroll && window.innerWidth < 760) $('detailCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (error) {
        setStatus($('detailStatus'), error.message, true);
      }
    }

    function renderDetail() {
      const { profile, state } = selectedData;
      $('detailName').textContent = profile.name;
      $('detailMeta').textContent = `${profile.interval === 'weekly' ? 'Ugentlig' : 'Daglig'} · ${modelLabel(profile.model)} · Maks. ${profile.maxPrice == null ? 'ikke sat' : formatPrice(profile.maxPrice)} · Senest ${formatDate(profile.lastRun)}`;
      $('toggleBtn').textContent = profile.enabled ? 'Sæt på pause' : 'Aktivér';
      $('analysis').textContent = profile.lastAnalysis || 'Profilen er ikke kørt endnu.';

      const summary = state?.summary || profile.lastSummary || {};
      $('detailStats').innerHTML = `
        <span class="pill">${summary.totalActive ?? 0} aktive</span>
        <span class="pill new">${summary.newCount ?? 0} nye</span>
        <span class="pill new">${summary.returnedCount ?? 0} tilbage</span>
        <span class="pill drop">${summary.priceDropCount ?? 0} prisfald</span>
        <span class="pill removed">${summary.removedCount ?? 0} forsvundet</span>
        <span class="pill">${summary.interestingCount ?? 0} interessante</span>`;

      renderFilters();
      renderListings();
    }

    function renderFilters() {
      const filters = [
        ['active', 'Aktive'], ['changes', 'Ændringer'], ['interesting', 'Interessante'],
        ['contacted', 'Kontaktet'], ['removed', 'Forsvundne'], ['all', 'Alle']
      ];
      $('filters').innerHTML = filters.map(([key, label]) =>
        `<button class="filter ${activeFilter === key ? 'active' : ''}" data-filter="${key}">${label}</button>`
      ).join('');
      document.querySelectorAll('[data-filter]').forEach(button => {
        button.addEventListener('click', () => {
          activeFilter = button.dataset.filter;
          renderFilters();
          renderListings();
        });
      });
    }

    function filteredListings() {
      const listings = selectedData?.state?.listings || [];
      if (activeFilter === 'active') return listings.filter(item => item.change !== 'removed' && item.userStatus !== 'dismissed');
      if (activeFilter === 'changes') return listings.filter(item => ['new', 'returned', 'price_drop'].includes(item.change));
      if (activeFilter === 'interesting') return listings.filter(item => item.userStatus === 'interesting');
      if (activeFilter === 'contacted') return listings.filter(item => item.userStatus === 'contacted');
      if (activeFilter === 'removed') return listings.filter(item => item.change === 'removed');
      return listings;
    }

    function renderListings() {
      const listings = filteredListings();
      if (!selectedData?.state) {
        $('listingList').innerHTML = '<div class="empty">Kør profilen for at oprette en baseline.</div>';
        return;
      }
      if (!listings.length) {
        $('listingList').innerHTML = '<div class="empty">Ingen annoncer i dette filter.</div>';
        return;
      }

      $('listingList').innerHTML = listings.map(item => `
        <article class="listing ${item.change === 'removed' ? 'removed' : ''}">
          <div class="listing-top">
            <div class="listing-title">
              <a href="https://www.dba.dk/recommerce/forsale/item/${encodeURIComponent(item.id)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.name || item.id)}</a>
              <div class="listing-meta">${escapeHtml(changeLabel(item.change))} · Først set ${escapeHtml(formatDate(item.firstSeen))}</div>
            </div>
            <div class="price">
              ${item.previousPrice != null ? `<div class="old-price">${escapeHtml(formatPrice(item.previousPrice))}</div>` : ''}
              ${escapeHtml(formatPrice(item.price))}
            </div>
          </div>
          <div class="listing-actions">
            ${statusButton(item, 'unreviewed', 'Ikke vurderet')}
            ${statusButton(item, 'interesting', 'Interessant')}
            ${statusButton(item, 'contacted', 'Kontaktet')}
            ${statusButton(item, 'dismissed', 'Afvist')}
          </div>
        </article>`).join('');

      document.querySelectorAll('[data-listing-id][data-status]').forEach(button => {
        button.addEventListener('click', () => setCandidateStatus(button.dataset.listingId, button.dataset.status));
      });
    }

    function statusButton(item, status, label) {
      return `<button class="status-btn ${item.userStatus === status ? 'active' : ''}" data-listing-id="${escapeHtml(item.id)}" data-status="${status}">${label}</button>`;
    }

    async function setCandidateStatus(listingId, userStatus) {
      try {
        await api(`/api/watchlists/${encodeURIComponent(selectedId)}/listings/${encodeURIComponent(listingId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ userStatus }),
        });
        await selectProfile(selectedId, false);
        await loadProfiles();
      } catch (error) {
        setStatus($('detailStatus'), error.message, true);
      }
    }

    async function runSelected() {
      if (!selectedId) return;
      const button = $('runBtn');
      button.disabled = true;
      setStatus($('detailStatus'), 'Henter alle DBA-sider og analyserer ændringer…');
      try {
        await api(`/api/watchlists/${encodeURIComponent(selectedId)}/run`, { method: 'POST', body: '{}' });
        await loadProfiles();
        await selectProfile(selectedId, false);
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
        await api(`/api/watchlists/${encodeURIComponent(selectedId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: !selectedData.profile.enabled }),
        });
        await loadProfiles();
        await selectProfile(selectedId, false);
      } catch (error) {
        setStatus($('detailStatus'), error.message, true);
      }
    }

    async function deleteSelected() {
      if (!selectedData || !confirm(`Slet overvågningen “${selectedData.profile.name}”?`)) return;
      try {
        await api(`/api/watchlists/${encodeURIComponent(selectedId)}`, { method: 'DELETE' });
        selectedId = null;
        selectedData = null;
        $('detailCard').hidden = true;
        await loadProfiles();
      } catch (error) {
        setStatus($('detailStatus'), error.message, true);
      }
    }

    loadProfiles();
