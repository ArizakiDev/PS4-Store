(function () {
  'use strict';
  var T = {};
  try { T = JSON.parse(document.getElementById('data-i18n').textContent); } catch (e) {  }
  function tr(key, vars) {
    var s = T[key] != null ? T[key] : key;
    if (vars) Object.keys(vars).forEach(function (k) { s = s.split('{' + k + '}').join(vars[k]); });
    return s;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  var toast = document.getElementById('toast'), toastTimer = null;
  function showToast(type, message) {
    toast.className = 'toast ' + type; toast.textContent = message; void toast.offsetWidth; toast.classList.add('is-visible');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { toast.classList.remove('is-visible'); }, type === 'error' ? 7000 : 3800);
  }
  var flash = JSON.parse(document.getElementById('data-flash').textContent);
  var gamesNode = document.getElementById('data-games');
  if (!gamesNode) { if (flash) showToast(flash.type, flash.message); return; }

  var tabs = Array.prototype.slice.call(document.querySelectorAll('[data-tab]'));
  var panels = { jeux: document.getElementById('panel-jeux'), vitrine: document.getElementById('panel-vitrine'), collections: document.getElementById('panel-collections'), demandes: document.getElementById('panel-demandes'), comptes: document.getElementById('panel-comptes') };
  function selectTab(name) {
    if (!panels[name]) name = 'jeux';
    tabs.forEach(function (t) { t.setAttribute('aria-selected', String(t.dataset.tab === name)); });
    Object.keys(panels).forEach(function (k) { if (panels[k]) panels[k].hidden = k !== name; });
    if (history.replaceState) history.replaceState(null, '', '#' + name);
  }
  tabs.forEach(function (t) { t.addEventListener('click', function () { selectTab(t.dataset.tab); }); });
  document.querySelectorAll('[data-tab-link]').forEach(function (l) {
    l.addEventListener('click', function (e) { e.preventDefault(); selectTab(l.dataset.tabLink); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  });
  var initial = (location.hash || '').replace('#', '');
  selectTab(panels[initial] ? initial : 'jeux');

  var games = JSON.parse(gamesNode.textContent);
  var byId = {}; games.forEach(function (g) { byId[g.id] = g; });

  var editModal = document.getElementById('modal-edit'), delModal = document.getElementById('modal-delete');
  var form = document.getElementById('form-edit');
  var lastFocus = null;
  function openModal(modal) {
    lastFocus = document.activeElement; modal.classList.add('is-open'); void modal.offsetWidth; modal.classList.add('is-visible');
    var first = modal.querySelector('input:not([type=hidden]), select, button'); if (first) setTimeout(function () { first.focus(); }, 60);
    document.body.style.overflow = 'hidden';
  }
  function closeModal(modal) {
    modal.classList.remove('is-visible'); setTimeout(function () { modal.classList.remove('is-open'); }, 350);
    document.body.style.overflow = ''; if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  var el = function (id) { return document.getElementById(id); };
  var DIRS = { plugin: '/data/GoldHEN/plugins', cheat: '/data/GoldHEN/cheats/json', patch: '/data/GoldHEN/patches/xml', payload: '/data/GoldHEN/payloads' };
  var PLACEHOLDERS = { plugin: 'mod.prx', cheat: 'CUSA00000_01.00.json', patch: 'CUSA00000.xml', payload: 'payload.bin' };
  var simpleFields = ['titre', 'title_id', 'description', 'version', 'firmware_min', 'categorie', 'size', 'icon_url', 'pkg_url', 'youtube_url'];

  function typeOf() { return el('f-type').value; }
  function isMod() { var t = typeOf(); return t === 'plugin' || t === 'payload'; }

  function recompute(r) {
    var target = el('pc-target').value;
    var titleId = el('pc-' + r + '-title').value.trim().toUpperCase();
    var file = el('pc-' + r + '-file').value.trim();
    el('pc-' + r + '-dir').value = DIRS[target] || '';
    el('pc-' + r + '-sec').value = target === 'plugin' ? '[' + (titleId || 'default') + ']' : '';
    el('pc-' + r + '-line').value = target === 'plugin' && file ? DIRS.plugin + '/' + file : '';
  }
  function applyRegions() {
    var scope = el('pc-regions').value;
    var target = el('pc-target').value;
    ['eu', 'us'].forEach(function (r) {
      var box = el('box-' + r);
      box.hidden = !(scope === 'BOTH' || scope === r.toUpperCase());
      box.querySelector('[data-needs-titleid]').hidden = target === 'payload';
      box.querySelector('[data-ini]').hidden = target !== 'plugin';
      el('pc-' + r + '-file').placeholder = PLACEHOLDERS[target] || '';
      recompute(r);
    });
  }
  function applyType() {
    var type = typeOf(), mod = isMod();
    el('pc-section').hidden = !mod;
    var targetSel = el('pc-target');
    Array.prototype.forEach.call(targetSel.options, function (o) {
      var allowed = type === 'payload' ? o.value === 'payload' : o.value !== 'payload';
      o.disabled = !allowed; o.hidden = !allowed;
    });
    if (targetSel.options[targetSel.selectedIndex].disabled) targetSel.value = type === 'payload' ? 'payload' : 'plugin';
    var showParent = type === 'update' || type === 'dlc' || type === 'plugin';
    el('parent-field').hidden = !showParent;
    if (!showParent) el('f-parent').value = '';
    el('f-titleid').required = false;
    el('titleid-hint').textContent = mod ? tr('dash.js.titleid_auto') : (type === 'pkg' ? tr('dash.js.titleid_main') : tr('dash.js.titleid_shared'));
    el('link-label').textContent = mod ? tr('dash.f.link.file') : tr('dash.f.link.pkg');
    el('type-hint').textContent = tr('dash.js.hint.' + type);
    el('pkg-url').placeholder = mod ? 'https://…/fichier' : 'https://drive.google.com/file/d/…/view';
    applyRegions();
  }
  el('f-type').addEventListener('change', applyType);
  el('pc-regions').addEventListener('change', applyRegions);
  el('pc-target').addEventListener('change', applyRegions);
  ['eu', 'us'].forEach(function (r) {
    ['title', 'file'].forEach(function (k) { el('pc-' + r + '-' + k).addEventListener('input', function () { recompute(r); }); });
  });

  var ytStatus = el('yt-status'), ytPreview = el('yt-preview'), pkgStatus = el('pkg-status'), pkgReport = el('pkg-report'), aiStatus = el('ai-status'), aiReport = el('ai-report');
  function setStatus(node, kind, msg) { node.className = 'yt-status' + (kind ? ' ' + kind : ''); node.textContent = msg || ''; }
  function today() { return new Date().toISOString().slice(0, 10); }

  function fillForm(id, values) {
    form.reset();
    values = values || {};
    el('f-type').value = values.resource_type || 'pkg';
    simpleFields.forEach(function (k) { if (values[k] != null && form.elements[k]) form.elements[k].value = values[k]; });
    form.elements.screenshots.value = Array.isArray(values.screenshots) ? values.screenshots.join('\n') : '';
    el('f-parent').value = values.parent_title_id || '';
    el('force-proxy').checked = !!values.force_proxy;
    var pc = values.plugin_config || {};
    el('pc-regions').value = pc.supported_regions || 'BOTH';
    el('pc-target').value = pc.target_type || (values.resource_type === 'payload' ? 'payload' : 'plugin');
    ['eu', 'us'].forEach(function (r) {
      var rc = pc[r] || {};
      el('pc-' + r + '-title').value = rc.title_id || '';
      el('pc-' + r + '-file').value = rc.filename || '';
    });
    el('cl-version').value = values.version || '';
    el('cl-date').value = today();
    var saved = id && byId[id] ? byId[id].changelog || [] : [];
    el('cl-history').hidden = !saved.length;
    el('cl-list').innerHTML = saved.map(function (c) { return '<li><b>v' + esc(c.version) + '</b> · ' + esc(c.date) + '<br>' + esc(c.notes) + '</li>'; }).join('');
    el('edit-title').textContent = id ? tr('dash.m.edit.title') : tr('dash.m.add.title');
    form.action = id ? '/dashboard/games/' + encodeURIComponent(id) : '/dashboard/games';
    el('edit-submit').disabled = false;
    el('edit-submit').textContent = id ? el('edit-submit').getAttribute('data-save') : el('edit-submit').getAttribute('data-publish');
    setStatus(ytStatus, '', ''); ytPreview.classList.remove('is-on');
    setStatus(pkgStatus, '', ''); pkgReport.hidden = true;
    setStatus(aiStatus, '', ''); aiReport.hidden = true;
    applyType();
    renderMedia();
  }

  el('btn-add').addEventListener('click', function () { fillForm('', null); openModal(editModal); });
  document.querySelectorAll('[data-edit]').forEach(function (btn) {
    btn.addEventListener('click', function () { var id = btn.getAttribute('data-edit'); fillForm(id, byId[id]); openModal(editModal); });
  });

  function bumpVersion(v) {
    var m = String(v || '').match(/^(.*?)(\d+)$/);
    if (!m) return '';
    var n = String(parseInt(m[2], 10) + 1); while (n.length < m[2].length) n = '0' + n;
    return m[1] + n;
  }
  document.querySelectorAll('[data-update]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var id = btn.getAttribute('data-update'), g = byId[id];
      el('form-update').reset();
      el('form-update').action = '/dashboard/games/' + encodeURIComponent(id) + '/publish-update';
      el('update-title').textContent = tr('dash.js.update_title', { title: g.titre });
      el('up-version').value = bumpVersion(g.version);
      el('up-patch-row').style.display = (g.resource_type || 'pkg') === 'pkg' ? '' : 'none';
      openModal(updModal);
    });
  });

  function askDelete(action, text) { el('delete-text').textContent = text; el('form-delete').action = action; openModal(delModal); }
  document.querySelectorAll('[data-delete]').forEach(function (btn) {
    btn.addEventListener('click', function () { var id = btn.getAttribute('data-delete'); askDelete('/dashboard/games/' + encodeURIComponent(id) + '/delete', tr('dash.js.del_game', { title: byId[id].titre })); });
  });
  var updModal = el('modal-update');
  var modals = [editModal, delModal, updModal];
  modals.forEach(function (modal) {
    modal.addEventListener('mousedown', function (e) { if (e.target === modal) closeModal(modal); });
    modal.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', function () { closeModal(modal); }); });
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') modals.forEach(function (m) { if (m.classList.contains('is-open')) closeModal(m); }); });
  form.addEventListener('submit', function () { el('edit-submit').disabled = true; });

  function csrf() { return el('csrf-edit').value; }
  function postJson(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (data) { return { ok: r.ok, data: data }; }); });
  }

  var checkBtn = el('pkg-check');
  checkBtn.addEventListener('click', function () {
    var url = el('pkg-url').value.trim();
    if (!url) { setStatus(pkgStatus, 'err', tr('dash.js.enter_link')); return; }
    checkBtn.disabled = true; pkgReport.hidden = true; setStatus(pkgStatus, '', tr('dash.js.checking'));
    postJson('/dashboard/check-link', { url: url, resource_type: typeOf(), target_type: el('pc-target').value }).then(function (res) {
      if (!res.ok) { setStatus(pkgStatus, 'err', res.data.erreur || tr('dash.js.check_failed')); return; }
      var d = res.data, rows = [], f = form.elements;
      rows.push('<div>' + tr('dash.js.host') + ' <b>' + esc(d.host) + '</b> · <b>' + (d.mode === 'direct' ? tr('dash.js.mode.direct') : tr('dash.js.mode.relay')) + '</b></div>');
      var fine = true;
      if (d.checked === false) { rows.push('<div class="warn">' + esc(d.message) + '</div>'); fine = false; }
      else {
        rows.push('<div>' + tr('dash.js.size') + ' <b>' + (d.size_label ? esc(d.size_label) : tr('dash.js.unknown')) + '</b> · ' + tr('dash.js.range') + ' ' + (d.accepts_range ? '<span class="good">' + tr('dash.js.range.yes') + '</span>' : '<span class="warn">' + tr('dash.js.range.no') + '</span>') + '</div>');
        if (!f.size.value.trim() && d.size_label) f.size.value = d.size_label;
        if (d.kind === 'file') rows.push('<div class="good">' + tr('dash.js.file_ok') + '</div>');
        else if (d.pkg_valid) {
          rows.push('<div class="good">' + tr('dash.js.pkg_ok') + ' ' + esc(d.pkg.type) + ' · ' + esc(d.pkg.content_id) + '</div>');
          if (d.type_ok === false) rows.push('<div class="warn">' + tr('dash.js.type_mismatch') + '</div>');
          if (!/^[A-Z]{4}[0-9]{5}$/i.test(f.title_id.value.replace(/\s+/g, '')) && /^[A-Z]{4}[0-9]{5}$/.test(d.pkg.title_id)) { if (f.title_id.value.trim() && !f.titre.value.trim()) f.titre.value = f.title_id.value.trim(); f.title_id.value = d.pkg.title_id; }
          else if (f.title_id.value.replace(/\s+/g, '').toUpperCase() !== d.pkg.title_id) rows.push('<div class="warn">' + tr('dash.js.titleid_diff', { found: esc(d.pkg.title_id), typed: esc(f.title_id.value.toUpperCase()) }) + '</div>');
        } else { rows.push('<div class="bad">' + tr('dash.js.pkg_bad') + '</div>'); fine = false; }
      }
      pkgReport.innerHTML = rows.join(''); pkgReport.hidden = false;
      setStatus(pkgStatus, fine ? 'ok' : 'err', fine ? tr('dash.js.link_valid') : (d.checked === false ? tr('dash.js.link_unchecked') : tr('dash.js.link_notpkg')));
    }).catch(function () { setStatus(pkgStatus, 'err', tr('dash.js.net_error')); }).then(function () { checkBtn.disabled = false; });
  });

  var aiBtn = el('ai-run');
  aiBtn.addEventListener('click', function () {
    var f = form.elements;
    if (!f.titre.value.trim() && !f.description.value.trim() && !el('pkg-url').value.trim()) { setStatus(aiStatus, 'err', tr('dash.js.ai_need_desc')); return; }
    aiBtn.disabled = true; aiReport.hidden = true; setStatus(aiStatus, '', tr('dash.js.ai_running'));
    postJson('/dashboard/ai-plugin-helper', {
      resource_type: typeOf(), scope: el('pc-regions').value, titre: f.titre.value, description: f.description.value,
      pkg_url: el('pkg-url').value, target_type: el('pc-target').value,
    }).then(function (res) {
      if (!res.ok) { setStatus(aiStatus, 'err', res.data.erreur || tr('dash.js.ai_failed')); return; }
      var d = res.data, pc = d.plugin_config || {};
      var allowed = el('pc-target').querySelector('option[value="' + pc.target_type + '"]');
      if (allowed && !allowed.disabled) el('pc-target').value = pc.target_type;
      ['eu', 'us'].forEach(function (r) {
        var rc = pc[r] || {};
        if (rc.title_id || rc.filename) { el('pc-' + r + '-title').value = rc.title_id || ''; el('pc-' + r + '-file').value = rc.filename || ''; }
      });
      applyRegions();
      var html = '<div><b>' + (d.source === 'ollama' ? tr('dash.js.ai_ollama', { model: esc(d.model) }) : tr('dash.js.ai_fallback')) + '</b>' + (d.game ? ' · ' + esc(d.game) : '') + '</div>';
      if (d.explanation) html += '<div>' + esc(d.explanation) + '</div>';
      if (d.warnings && d.warnings.length) html += '<ul>' + d.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>';
      aiReport.innerHTML = html; aiReport.hidden = false;
      setStatus(aiStatus, 'ok', tr('dash.js.ai_done'));
    }).catch(function () { setStatus(aiStatus, 'err', tr('dash.js.net_error')); }).then(function () { aiBtn.disabled = false; });
  });

  var fetchBtn = el('yt-fetch');
  fetchBtn.addEventListener('click', function () {
    var url = el('yt-url').value.trim();
    if (!url) { setStatus(ytStatus, 'err', tr('dash.js.enter_yt')); return; }
    fetchBtn.disabled = true; setStatus(ytStatus, '', tr('dash.js.fetching'));
    postJson('/dashboard/fetch-media', { url: url }).then(function (res) {
      if (!res.ok) { setStatus(ytStatus, 'err', res.data.erreur || tr('dash.js.yt_failed')); return; }
      var d = res.data;
      el('yt-url').value = d.youtube_url;
      if (!form.elements.titre.value.trim() && d.title) form.elements.titre.value = d.title;
      var shots = form.elements.screenshots, lines = shots.value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (lines.indexOf(d.thumbnail) === -1) lines.unshift(d.thumbnail);
      shots.value = lines.join('\n');
      if (!form.elements.icon_url.value.trim()) form.elements.icon_url.value = d.thumbnail;
      el('yt-thumb').src = d.thumbnail;
      el('yt-info').textContent = d.title + (d.channel ? ' — ' + d.channel : '');
      ytPreview.classList.add('is-on'); renderMedia();
      setStatus(ytStatus, 'ok', tr('dash.js.yt_done') + (d.thumbnail_hd ? '' : ' ' + tr('dash.js.yt_sd')));
    }).catch(function () { setStatus(ytStatus, 'err', tr('dash.js.net_error')); }).then(function () { fetchBtn.disabled = false; });
  });

  var mediaBtn = el('media-fetch'), mediaStatus = el('media-status');
  var coverBox = el('cover-preview'), coverThumb = el('cover-thumb'), ytEmbed = el('yt-embed'), gallery = el('shots-gallery');
  function ytIdOf(url) {
    var m = String(url || '').match(/(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
    return m ? m[1] : '';
  }
  function shotLines() { return form.elements.screenshots.value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean); }
  function renderMedia() {
    var icon = form.elements.icon_url.value.trim();
    coverBox.classList.toggle('is-on', !!icon);
    if (icon) { coverThumb.src = icon; el('cover-info').textContent = tr('dash.js.media_cover'); }
    var id = ytIdOf(el('yt-url').value);
    ytEmbed.classList.toggle('is-on', !!id);
    var cur = ytEmbed.getAttribute('data-id') || '';
    if (id !== cur) {
      ytEmbed.setAttribute('data-id', id);
      ytEmbed.innerHTML = id ? '<iframe src="https://www.youtube-nocookie.com/embed/' + id + '?rel=0" loading="lazy" allow="encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>' : '';
    }
    gallery.innerHTML = '';
    shotLines().forEach(function (src, i) {
      var fig = document.createElement('figure'), img = document.createElement('img'), btn = document.createElement('button');
      img.src = src; img.alt = ''; img.loading = 'lazy';
      btn.type = 'button'; btn.textContent = '\u00d7'; btn.setAttribute('aria-label', tr('dash.js.media_remove'));
      btn.addEventListener('click', function () { var l = shotLines(); l.splice(i, 1); form.elements.screenshots.value = l.join('\n'); renderMedia(); });
      fig.appendChild(img); fig.appendChild(btn); gallery.appendChild(fig);
    });
  }
  form.elements.icon_url.addEventListener('input', renderMedia);
  el('yt-url').addEventListener('input', renderMedia);
  form.elements.screenshots.addEventListener('input', renderMedia);

  var mediaRunning = false;
  var ID_RE = /^[A-Z]{4}[0-9]{5}$/;
  function compactId(v) { return String(v || '').replace(/\s+/g, '').toUpperCase(); }
  function runMedia(auto) {
    if (mediaRunning) return Promise.resolve();
    var f = form.elements, raw = f.title_id.value.trim(), cid = compactId(raw);
    var tid = ID_RE.test(cid) ? cid : '', title = f.titre.value.trim() || (tid ? '' : raw);
    if (!tid && !title) { if (!auto) setStatus(mediaStatus, 'err', tr('dash.js.media_need')); return Promise.resolve(); }
    mediaRunning = true; mediaBtn.disabled = true; setStatus(mediaStatus, '', tr('dash.js.media_running'));
    return postJson('/dashboard/fetch-media', { title_id: tid || raw, title: tid ? f.titre.value.trim() : title }).then(function (res) {
      if (!res.ok) { setStatus(mediaStatus, 'err', res.data.erreur || tr('dash.js.media_failed')); return; }
      var d = res.data, found = 0;
      function put(field, value, force) { if (value && (force || !field.value.trim())) { field.value = value; found++; } }
      put(f.titre, d.title, !auto);
      put(f.description, d.description, !auto);
      put(f.icon_url, d.cover, !auto);
      put(el('yt-url'), d.youtube_url, !auto);
      if (d.screenshots && d.screenshots.length && (!auto || !shotLines().length)) { f.screenshots.value = d.screenshots.join('\n'); found++; }
      if (d.title_id && !tid) { f.title_id.value = d.title_id; }
      if (found) el('advanced').open = true;
      renderMedia();
      setStatus(mediaStatus, found ? 'ok' : 'err', found ? tr('dash.js.media_done') : tr('dash.js.media_none'));
    }).catch(function () { setStatus(mediaStatus, 'err', tr('dash.js.net_error')); }).then(function () { mediaRunning = false; mediaBtn.disabled = false; });
  }
  mediaBtn.addEventListener('click', function () { runMedia(false); });
  el('media-publish').addEventListener('click', function () {
    runMedia(false).then(function () {
      if (form.checkValidity()) form.requestSubmit(); else form.reportValidity();
    });
  });

  if (flash) {
    showToast(flash.type, flash.message);
    if (flash.type === 'error' && flash.form) { fillForm(flash.editId || '', flash.form); openModal(editModal); }
  }
})();


(function () {
  var btn = document.getElementById('discord-test'), st = document.getElementById('discord-status');
  if (!btn) return;
  btn.addEventListener('click', function () {
    btn.disabled = true; st.className = 'yt-status'; st.textContent = '…';
    fetch('/dashboard/discord-test', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': document.getElementById('csrf-edit').value }, body: '{}' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (r) { st.className = 'yt-status ' + (r.ok ? 'ok' : 'err'); st.textContent = r.ok ? 'OK' : (r.d.erreur || 'Erreur'); })
      .catch(function () { st.className = 'yt-status err'; st.textContent = 'Erreur réseau'; })
      .then(function () { btn.disabled = false; });
  });
})();


(function () {
  var csrfEl = document.getElementById('csrf-edit');
  document.querySelectorAll('[data-check-sub]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var out = btn.closest('div').parentNode.querySelector('[data-check-out]');
      out.textContent = '…'; btn.disabled = true;
      fetch('/dashboard/check-link', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfEl ? csrfEl.value : '' },
        body: JSON.stringify({ url: btn.getAttribute('data-url'), resource_type: btn.getAttribute('data-type'), target_type: btn.getAttribute('data-target') }) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (r) {
          var d = r.d;
          if (!r.ok) { out.textContent = d.erreur || 'Erreur'; return; }
          var parts = [d.host ? d.host : '', d.size_label ? d.size_label : ''];
          if (d.checked === false) parts.push(d.message || '');
          else if (d.kind === 'file') parts.push('OK');
          else if (d.pkg_valid) parts.push('.pkg ' + (d.pkg && d.pkg.type ? d.pkg.type : '') + ' · ' + (d.pkg && d.pkg.title_id ? d.pkg.title_id : '') + (d.type_ok === false ? ' ⚠ type' : ''));
          else parts.push('⚠ .pkg invalide');
          out.textContent = parts.filter(Boolean).join(' · ');
        })
        .catch(function () { out.textContent = 'Erreur réseau'; })
        .then(function () { btn.disabled = false; });
    });
  });
})();

(function () {
  'use strict';
  document.addEventListener('input', function (e) {
    var f = e.target.closest ? e.target.closest('.col-filter') : null;
    if (!f) return;
    var q = f.value.trim().toLowerCase();
    Array.prototype.forEach.call(f.parentNode.querySelectorAll('.col-check'), function (l) { l.hidden = !!q && l.dataset.name.indexOf(q) === -1; });
  });
})();

(function () {
  'use strict';
  var dataNode = document.getElementById('data-vb');
  if (!dataNode) return;
  var D = JSON.parse(dataNode.textContent), L = D.labels;
  var STYLE_DEF = { bg_color: '', bg_color2: '', gradient: false, accent: '', text_color: '', bg_image: '', overlay: 60, blur: 0, radius: 24, glow: false, align: 'left' };
  var SPACE_DEF = { pad_top: '', pad_bottom: '', margin_top: '', margin_bottom: '', visibility: 'both' };
  var THEME_DEF = { accent: '', bg_color: '', radius: null, nav_style: 'default', card_style: 'glass', announce: { active: false, text: '', link_label: '', link_url: '', color: '#0070D1' } };
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function normalize(hp) {
    hp = hp || {}; hp.hero_carousel = hp.hero_carousel || []; hp.sections = hp.sections || []; hp.catalogue_sections = hp.catalogue_sections || []; hp.demandes_sections = hp.demandes_sections || []; hp.status_sections = hp.status_sections || []; hp.text_overrides = hp.text_overrides || {}; hp.hidden_elements = Array.isArray(hp.hidden_elements) ? hp.hidden_elements : ['hero_status_pill', 'hero_client_status'];
    hp.site_theme = Object.assign({}, THEME_DEF, hp.site_theme || {}); hp.site_theme.announce = Object.assign({}, THEME_DEF.announce, hp.site_theme.announce || {});
    hp.sections.concat(hp.catalogue_sections, hp.demandes_sections, hp.status_sections).forEach(ensure);
    return hp;
  }
  function ensure(s) { s.style = Object.assign({}, STYLE_DEF, s.style || {}); s.space = Object.assign({}, SPACE_DEF, s.space || {}); return s; }
  var saved = normalize(clone(D.homepage || {})), state = clone(saved);
  var games = {}; D.games.forEach(function (g) { games[g.id] = g; });
  var textMode = false;
  var page = 'home', selId = '', selSlide = '', insp = 'content', side = 'blocks', view = 'desktop', lastY = 0, hist = [];
  var o = {};
  var pvTimer = null, snapTimer = null;

  function uid() { return Math.random().toString(36).slice(2, 12); }
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { var v = attrs[k]; if (k === 'text') e.textContent = v; else if (k === 'class') e.className = v; else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v); });
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  var PAGES = { home: { url: '/', list: 'sections' }, catalogue: { url: '/catalogue', list: 'catalogue_sections' }, demandes: { url: '/demandes', list: 'demandes_sections' },
    status: { url: '/status', list: 'status_sections' }, footer: { url: '/demandes#footer', list: null }, theme: { url: '/', list: null } };
  function list() { var k = PAGES[page].list; if (!k) return []; state[k] = state[k] || []; return state[k]; }
  function findIdx(id) { var l = list(); for (var i = 0; i < l.length; i++) if (l[i].id === id) return i; return -1; }
  function cur() { var i = findIdx(selId); return i > -1 ? list()[i] : null; }
  function setStatus(msg, cls) { o.status.textContent = msg || ''; o.status.className = 'wb-status' + (cls ? ' ' + cls : ''); }

  function snap() { hist.push(JSON.stringify(state)); if (hist.length > 60) hist.shift(); o.undo.disabled = false; }
  function snapSoon() { if (!snapTimer) snap(); clearTimeout(snapTimer); snapTimer = setTimeout(function () { snapTimer = null; }, 900); }
  function undo() { if (!hist.length) return; state = normalize(JSON.parse(hist.pop())); o.undo.disabled = !hist.length; if (!cur() && page !== 'theme') selId = ''; renderSide(); pushPreview(true); }

  function frameUrl() { var u = PAGES[page].url.split('#'); return u[0] + '?preview=1&edit=1' + (u[1] ? '#' + u[1] : ''); }
  function pushPreview(reload) {
    clearTimeout(pvTimer);
    pvTimer = setTimeout(function () {
      fetch('/dashboard/homepage/preview', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': D.csrf }, body: JSON.stringify(state) })
        .then(function (r) { if (!r.ok || !reload) return; try { o.frame.contentWindow.location.reload(); } catch (e) { o.frame.src = frameUrl(); } }).catch(function () {});
    }, 300);
  }
  function loadFrame() {
    fetch('/dashboard/homepage/preview', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': D.csrf }, body: JSON.stringify(state) })
      .then(function () { o.frame.src = frameUrl(); });
  }
  function toFrame(m) { try { m.wb = 1; o.frame.contentWindow.postMessage(m, location.origin); } catch (e) {} }

  var NEW = {
    carousel: function () { return { type: 'carousel', mode: 'hybrid', autoplay_s: 6, auto_count: 4, auto_filter: 'all' }; },
    collab_banner: function () { return { type: 'collab_banner', badge: 'Collaboration', title: 'Titre de la collaboration', description: 'Décrivez la collaboration entre vos créateurs.', image_url: '', accent_color: '#7C3AED', creators: ['', ''], cta_label: '', cta_url: '' }; },
    spotlight_game: function () { return { type: 'spotlight_game', game_id: D.games[0] ? D.games[0].id : '', badge: 'Partenaire', title: '', description: '', image_url: '', note: L['wb.note_sponsored'], accent_color: '#0070D1' }; },
    cta_banner: function () { return { type: 'cta_banner', badge: '', icon: '📣', title: 'Rejoignez la communauté', text: 'Un message court pour inviter les visiteurs à agir.', cta_label: 'En savoir plus', cta_url: '/catalogue', accent_color: '#0070D1' }; },
    rich_text: function () { return { type: 'rich_text', width: 'normal', html: '<h2>Votre titre</h2><p>Cliquez ici pour écrire votre texte. Une barre d\'outils apparaît pour la mise en forme.</p>' }; },
    features_grid: function () { return { type: 'features_grid', title: 'Pourquoi PS4Store ?', cols: 3, items: [{ icon: '⚡', title: 'Rapide', text: 'Téléchargements directs, sans attente.' }, { icon: '🛡️', title: 'Sûr', text: 'Ressources vérifiées par la communauté.' }, { icon: '🎮', title: 'Simple', text: 'Tout se gère depuis votre manette.' }] }; },
    video: function () { return { type: 'video', title: 'Découvrez PS4Store en vidéo', url: '', caption: '' }; },
    faq: function () { return { type: 'faq', title: 'Questions fréquentes', items: [{ q: 'Comment installer PS4Store ?', a: 'Suivez le guide d\'installation de la page d\'accueil.' }, { q: 'Est-ce gratuit ?', a: 'Oui, entièrement gratuit.' }] }; },
    discord_invite: function () { return { type: 'discord_invite', title: 'Rejoignez notre Discord', text: 'Discutez, partagez et suivez les nouveautés avec la communauté.', invite_url: '', guild_id: '', channels: [], button_label: 'Rejoindre le Discord' }; },
    counters: function () { return { type: 'counters', items: [{ value: '1 200+', label: 'Ressources', sub: 'et ça continue' }, { value: '350', label: 'Créateurs', sub: 'actifs' }, { value: '24/7', label: 'Disponible', sub: '' }] }; },
    gallery: function () { return { type: 'gallery', title: 'Galerie', layout: 'grid', images: [{ url: '', caption: '' }, { url: '', caption: '' }, { url: '', caption: '' }] }; },
    top_creators: function () { return { type: 'top_creators', title: 'Top Créateurs', mode: 'auto', count: 3, creators: [] }; },
    button_bar: function () { return { type: 'button_bar', align: 'center', buttons: [{ label: 'Découvrir', url: '/catalogue', color: '#0070D1', icon: '🎮', size: 'medium' }, { label: 'Discord', url: '', color: '#5865F2', icon: '💬', size: 'medium' }] }; },
    spacer: function () { return { type: 'spacer', height: 48, line: true, title: '' }; },
    latest_grid: function () { return { type: 'latest_grid', title: '', count: 8, filter: 'all' }; }
  };
  function addSection(type, at) {
    if (type === 'site_style') { openTheme(); return; }
    if (!NEW[type] || !PAGES[page].list) return;
    snap();
    var s = ensure(Object.assign({ id: uid(), active: true }, NEW[type]()));
    var l = list(); at = Math.max(0, Math.min(l.length, at == null ? l.length : at)); l.splice(at, 0, s);
    selId = s.id; selSlide = ''; insp = 'content'; side = 'insp'; renderSide(); pushPreview(true);
    setTimeout(function () { toFrame({ t: 'select', id: s.id, scroll: true }); }, 700);
  }
  function moveSection(id, to) { var l = list(), f = findIdx(id); if (f < 0) return; snap(); var m = l.splice(f, 1)[0]; if (to > f) to--; l.splice(Math.max(0, Math.min(l.length, to)), 0, m); renderSide(); pushPreview(true); }
  function dupSection(id) { var l = list(), i = findIdx(id); if (i < 0) return; snap(); var d = clone(l[i]); d.id = uid(); l.splice(i + 1, 0, d); selId = d.id; renderSide(); pushPreview(true); }
  function delSection(id) { var l = list(), i = findIdx(id); if (i < 0 || !confirm(L['wb.confirm_del'])) return; snap(); l.splice(i, 1); if (selId === id) { selId = ''; side = 'blocks'; } renderSide(); pushPreview(true); }

  function field(label, input, hint) { return h('label', { class: 'field' }, [h('span', { text: label }), input, hint ? h('small', { class: 'wb-hint', text: hint }) : null]); }
  function changed(live) { snapSoon(); pushPreview(true); if (live) live(); }
  function text(obj, key, opts) {
    opts = opts || {};
    var el = h(opts.area ? 'textarea' : 'input', { type: opts.area ? null : (opts.type || 'text'), maxlength: opts.max || 200, list: opts.list || null, placeholder: opts.ph || null, min: opts.min, max_: null });
    if (opts.min != null) el.min = opts.min; if (opts.maxv != null) el.max = opts.maxv;
    el.value = obj[key] == null ? '' : obj[key];
    el.addEventListener('input', function () { obj[key] = opts.num ? (el.value === '' ? '' : Number(el.value)) : el.value; changed(); });
    return el;
  }
  function select(obj, key, options, after) {
    var el = h('select', {}, options.map(function (x) { return h('option', { value: x[0], text: x[1] }); }));
    el.value = String(obj[key] == null ? '' : obj[key]);
    el.addEventListener('change', function () { obj[key] = el.value; snap(); pushPreview(true); if (after) after(el.value); });
    return el;
  }
  function range(obj, key, min, max, unit) {
    var out = h('output', { text: (obj[key] == null || obj[key] === '' ? min : obj[key]) + unit });
    var el = h('input', { type: 'range', min: min, max: max, step: 1 }); el.value = obj[key] == null || obj[key] === '' ? min : obj[key];
    el.addEventListener('input', function () { obj[key] = Number(el.value); out.textContent = el.value + unit; changed(); });
    return h('div', { class: 'wb-up' }, [el, out]);
  }
  function colorField(obj, key, label, allowClear) {
    var el = h('input', { type: 'color' }); el.value = obj[key] || '#0070d1';
    el.addEventListener('input', function () { obj[key] = el.value; changed(); });
    var clear = allowClear ? h('button', { type: 'button', class: 'wb-ico', title: L['wb.reset_field'], text: '✕' }) : null;
    if (clear) clear.addEventListener('click', function () { snap(); obj[key] = ''; el.value = '#0070d1'; pushPreview(true); });
    return field(label, h('div', { class: 'wb-up' }, [el, clear]));
  }
  function check(obj, key, label) { var cb = h('input', { type: 'checkbox' }); cb.checked = !!obj[key]; cb.addEventListener('change', function () { obj[key] = cb.checked; snap(); pushPreview(true); }); return h('label', { class: 'check' }, [cb, h('span', { text: label })]); }
  function two(a, b) { return h('div', { class: 'wb-two' }, [a, b]); }
  function imageField(obj, key) {
    var inp = text(obj, key, { max: 500, ph: 'https://… ou /uploads/…' }); inp.style.flex = '1 1 120px';
    var file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
    var btn = h('button', { type: 'button', class: 'btn ghost small', text: L['wb.upload'] });
    var thumb = h('img', { alt: '', src: obj[key] || '', hidden: !obj[key] });
    btn.addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () {
      var f = file.files[0]; if (!f) return; setStatus(L['wb.uploading']);
      var img = new Image(), url = URL.createObjectURL(f);
      img.onload = function () {
        var w = Math.min(1600, img.width), hh = Math.round(img.height * (w / img.width)), c = document.createElement('canvas'); c.width = w; c.height = hh;
        c.getContext('2d').drawImage(img, 0, 0, w, hh); URL.revokeObjectURL(url);
        c.toBlob(function (blob) {
          fetch('/dashboard/homepage/banner', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'image/jpeg', 'X-CSRF-Token': D.csrf }, body: blob })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
            .then(function (r) { if (!r.ok) { setStatus(r.d.erreur || L['wb.img_bad'], 'err'); return; } snap(); obj[key] = r.d.url; inp.value = r.d.url; thumb.src = r.d.url; thumb.hidden = false; setStatus(''); pushPreview(true); })
            .catch(function () { setStatus(L['wb.error'], 'err'); });
        }, 'image/jpeg', 0.85);
      };
      img.onerror = function () { setStatus(L['wb.img_bad'], 'err'); }; img.src = url;
    });
    return h('div', { class: 'wb-up' }, [inp, btn, file, thumb]);
  }
  function gameSelect(obj, key) {
    var opts = [['', L['wb.custom']]].concat(D.games.map(function (g) { return [g.id, g.titre + ' (' + g.title_id + ')']; }));
    return select(obj, key, opts, function (id) {
      var g = games[id];
      if (g) { obj.title = g.titre; if ('description' in obj) obj.description = g.desc; else obj.subtitle = g.desc; obj.image_url = g.img; if ('cta_url' in obj) obj.cta_url = '/jeu/' + g.id; }
      renderSide(); pushPreview(true);
    });
  }
  function badgeList() { if (!document.getElementById('wb-badges')) document.body.appendChild(h('datalist', { id: 'wb-badges' }, ['Sponsorisé', 'Nouveauté', 'Exclu PS4', 'Partenaire', 'Mise en avant', 'Collaboration'].map(function (v) { return h('option', { value: v }); }))); return 'wb-badges'; }
  if (!document.getElementById('wb-creators')) document.body.appendChild(h('datalist', { id: 'wb-creators' }, D.creators.map(function (c) { return h('option', { value: c.username, label: c.name }); })));

  function slideFields(sl) {
    return [
      field(L['wb.game'], gameSelect(sl, 'game_id')),
      two(field(L['wb.badge'], text(sl, 'badge', { max: 30, list: badgeList() })), colorField(sl, 'accent_color', L['wb.accent'])),
      field(L['wb.title_f'], text(sl, 'title', { max: 80 })), field(L['wb.subtitle'], text(sl, 'subtitle', { area: true, max: 220 })),
      field(L['wb.image'], imageField(sl, 'image_url')),
      two(field(L['wb.cta_label'], text(sl, 'cta_label', { max: 30 })), field(L['wb.cta_url'], text(sl, 'cta_url', { max: 500, ph: '/jeu/…' }))),
      two(field(L['wb.sponsored_by'], text(sl, 'sponsored_by', { max: 60 })), field(L['wb.expires'], dtField(sl, 'expires_at'))),
      check(sl, 'active', L['wb.active'])
    ];
  }
  function dtField(obj, key) {
    var el = h('input', { type: 'datetime-local' });
    if (obj[key]) { var d = new Date(obj[key]); if (!isNaN(d)) el.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
    el.addEventListener('change', function () { obj[key] = el.value ? new Date(el.value).toISOString() : ''; snap(); pushPreview(true); });
    return el;
  }
  function carouselContent(s) {
    var out = [field(L['wb.mode'], select(s, 'mode', [['auto', L['wb.mode.auto']], ['custom', L['wb.mode.custom']], ['hybrid', L['wb.mode.hybrid']]], function () { renderSide(); }))];
    if (s.mode !== 'custom') out.push(two(field(L['wb.auto_count'], text(s, 'auto_count', { type: 'number', num: true, min: 1, maxv: 8, max: 1 })), field(L['wb.auto_filter'], select(s, 'auto_filter', [['all', L['wb.f.all']], ['games', L['wb.f.games']], ['mods', L['wb.f.mods']]]))));
    out.push(field(L['wb.autoplay'], text(s, 'autoplay_s', { type: 'number', num: true, min: 0, maxv: 30, max: 2 })));
    if (s.mode !== 'auto') {
      var box = h('div', { class: 'wb-slides' });
      state.hero_carousel.forEach(function (sl, i) {
        var row = h('div', { class: 'wb-slide' + (selSlide === sl.id ? ' on' : '') }, [h('span', { class: 't', text: (i + 1) + '. ' + (sl.title || L['wb.slide']) }),
          h('button', { type: 'button', class: 'wb-ico', text: '↑', title: L['wb.up'] }), h('button', { type: 'button', class: 'wb-ico', text: '↓', title: L['wb.down'] }), h('button', { type: 'button', class: 'wb-ico', text: '⧉', title: L['wb.dup'] }), h('button', { type: 'button', class: 'wb-ico', text: '✕', title: L['wb.del'] })]);
        var b = row.querySelectorAll('button');
        row.addEventListener('click', function (e) { if (e.target.closest('button')) return; selSlide = selSlide === sl.id ? '' : sl.id; renderInsp(); });
        b[0].addEventListener('click', function () { if (i > 0) { snap(); state.hero_carousel.splice(i - 1, 0, state.hero_carousel.splice(i, 1)[0]); renderInsp(); pushPreview(true); } });
        b[1].addEventListener('click', function () { if (i < state.hero_carousel.length - 1) { snap(); state.hero_carousel.splice(i + 1, 0, state.hero_carousel.splice(i, 1)[0]); renderInsp(); pushPreview(true); } });
        b[2].addEventListener('click', function () { snap(); var c = clone(sl); c.id = uid(); state.hero_carousel.splice(i + 1, 0, c); selSlide = c.id; renderInsp(); pushPreview(true); });
        b[3].addEventListener('click', function () { if (!confirm(L['wb.confirm_del'])) return; snap(); state.hero_carousel.splice(i, 1); if (selSlide === sl.id) selSlide = ''; renderInsp(); pushPreview(true); });
        box.appendChild(row);
        if (selSlide === sl.id) box.appendChild(h('div', { class: 'wb-fields' }, slideFields(sl)));
      });
      var add = h('button', { type: 'button', class: 'btn ghost small', text: '+ ' + L['wb.add_slide'] });
      add.addEventListener('click', function () { snap(); var sl = { id: uid(), badge: 'Nouveauté', title: '', subtitle: '', image_url: '', cta_label: 'Découvrir', cta_url: '', game_id: '', accent_color: '#0070D1', sponsored_by: '', expires_at: '', active: true }; state.hero_carousel.push(sl); selSlide = sl.id; renderInsp(); pushPreview(true); });
      out.push(h('strong', { text: L['wb.slides'] + ' (' + state.hero_carousel.length + ')' }), box, add);
    }
    return out;
  }
  function contentFields(s) {
    if (s.type === 'carousel') return carouselContent(s);
    if (s.type === 'rich_text') return [h('p', { class: 'wb-hint', text: L['wb.rich.hint'] }), field(L['wb.rich.width'], select(s, 'width', [['narrow', L['wb.rich.narrow']], ['normal', L['wb.rich.normal']], ['wide', L['wb.rich.wide']]]))];
    if (s.type === 'features_grid') {
      s.items = s.items || [];
      return [field(L['wb.title_f'], text(s, 'title', { max: 90 })), field(L['wb.cols'], select(s, 'cols', [[2, '2'], [3, '3'], [4, '4']], function (v) { s.cols = Number(v); })),
        h('strong', { text: L['wb.items'] + ' (' + s.items.length + '/8)' })].concat(listEditor(s.items, 8, [{ k: 'icon', label: L['wb.icon'], max: 4, ph: '⚡' }, { k: 'title', label: L['wb.title_f'], max: 60 }, { k: 'text', label: L['wb.desc'], area: true, max: 200 }], { icon: '✨', title: '', text: '' }, L['wb.add_item'], function (it) { return it.title; }));
    }
    if (s.type === 'video') return [field(L['wb.title_f'], text(s, 'title', { max: 90 })), field(L['wb.video.url'], text(s, 'url', { max: 300, ph: 'https://www.youtube.com/watch?v=…' }), L['wb.video.hint']), field(L['wb.caption'], text(s, 'caption', { max: 200 }))];
    if (s.type === 'faq') { s.items = s.items || []; return [field(L['wb.title_f'], text(s, 'title', { max: 90 })), h('strong', { text: L['wb.faq.items'] + ' (' + s.items.length + '/20)' })].concat(listEditor(s.items, 20, [{ k: 'q', label: L['wb.faq.q'], max: 160 }, { k: 'a', label: L['wb.faq.a'], area: true, max: 1000 }], { q: '', a: '' }, L['wb.faq.add'], function (it) { return it.q; })); }
    if (s.type === 'discord_invite') {
      var ch = h('textarea', { maxlength: 220, rows: 2, placeholder: 'annonces, général, aide' }); ch.value = (s.channels || []).join(', ');
      ch.addEventListener('input', function () { s.channels = ch.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 5); changed(); });
      return [field(L['wb.title_f'], text(s, 'title', { max: 90 })), field(L['wb.text'], text(s, 'text', { area: true, max: 240 })), field(L['wb.disc.invite'], text(s, 'invite_url', { max: 200, ph: 'https://discord.gg/…' })),
        field(L['wb.disc.guild'], text(s, 'guild_id', { max: 25, ph: '123456789012345678' }), L['wb.disc.guild_hint']), field(L['wb.disc.channels'], ch, L['wb.disc.channels_hint']), field(L['wb.disc.button'], text(s, 'button_label', { max: 30 }))];
    }
    if (s.type === 'counters') { s.items = s.items || []; return [h('strong', { text: L['wb.counters.items'] + ' (' + s.items.length + '/4)' })].concat(listEditor(s.items, 4, [{ k: 'value', label: L['wb.counters.value'], max: 20, ph: '1 200+' }, { k: 'label', label: L['wb.counters.label'], max: 40 }, { k: 'sub', label: L['wb.counters.sub'], max: 60 }], { value: '', label: '', sub: '' }, L['wb.add_item'], function (it) { return it.label || it.value; })); }
    if (s.type === 'gallery') { s.images = s.images || []; return [field(L['wb.title_f'], text(s, 'title', { max: 90 })), field(L['wb.gal.layout'], select(s, 'layout', [['grid', L['wb.gal.grid']], ['mosaic', L['wb.gal.mosaic']]])), h('strong', { text: L['wb.gal.images'] + ' (' + s.images.length + '/24)' })].concat(listEditor(s.images, 24, [{ k: 'url', label: L['wb.image'], kind: 'image' }, { k: 'caption', label: L['wb.caption'], max: 120 }], { url: '', caption: '' }, L['wb.gal.add'], function (it) { return it.caption; })); }
    if (s.type === 'top_creators') {
      var out2 = [field(L['wb.title_f'], text(s, 'title', { max: 90 })), field(L['wb.top.mode'], select(s, 'mode', [['auto', L['wb.top.auto']], ['manual', L['wb.top.manual']]], function () { renderInsp(); }))];
      if (s.mode === 'manual') { var cr2 = h('div', { class: 'wb-two' }); s.creators = s.creators || []; for (var q = 0; q < 4; q++) (function (k) { var inp = h('input', { list: 'wb-creators', maxlength: 40, placeholder: '@pseudo' }); inp.value = s.creators[k] || ''; inp.addEventListener('input', function () { s.creators[k] = inp.value; s.creators = s.creators.filter(function (x, n) { return x || n >= 4; }); changed(); }); cr2.appendChild(inp); })(q); out2.push(field(L['wb.creators'], cr2)); }
      else out2.push(field(L['wb.top.count'], select(s, 'count', [[2, '2'], [3, '3'], [4, '4']], function (v) { s.count = Number(v); })));
      return out2;
    }
    if (s.type === 'button_bar') { s.buttons = s.buttons || []; return [field(L['wb.align'], select(s, 'align', [['left', L['wb.align.left']], ['center', L['wb.align.center']]])), h('strong', { text: L['wb.btn.items'] + ' (' + s.buttons.length + '/3)' })].concat(listEditor(s.buttons, 3, [{ k: 'label', label: L['wb.cta_label'], max: 40 }, { k: 'url', label: L['wb.cta_url'], max: 500, ph: '/catalogue · https://…' }, { k: 'icon', label: L['wb.icon'], max: 4 }, { k: 'color', label: L['wb.accent'], kind: 'color' }, { k: 'size', label: L['wb.size'], kind: 'size' }], { label: 'Bouton', url: '', color: '#0070D1', icon: '', size: 'medium' }, L['wb.btn.add'], function (it) { return it.label; })); }
    if (s.type === 'collab_banner') {
      var cr = h('div', { class: 'wb-two' }); s.creators = s.creators || [];
      for (var i = 0; i < 4; i++) (function (k) { var inp = h('input', { list: 'wb-creators', maxlength: 40, placeholder: '@pseudo' }); inp.value = s.creators[k] || ''; inp.addEventListener('input', function () { s.creators[k] = inp.value; changed(); }); cr.appendChild(inp); })(i);
      return [two(field(L['wb.badge'], text(s, 'badge', { max: 30, list: badgeList() })), colorField(s, 'accent_color', L['wb.accent'])), field(L['wb.title_f'], text(s, 'title', { max: 90 })), field(L['wb.desc'], text(s, 'description', { area: true, max: 300 })),
        field(L['wb.image'], imageField(s, 'image_url')), field(L['wb.creators'], cr), two(field(L['wb.cta_label'], text(s, 'cta_label', { max: 30 })), field(L['wb.cta_url'], text(s, 'cta_url', { max: 500 })))];
    }
    if (s.type === 'spotlight_game') {
      return [field(L['wb.game'], gameSelect(s, 'game_id')), two(field(L['wb.badge'], text(s, 'badge', { max: 30, list: badgeList() })), colorField(s, 'accent_color', L['wb.accent'])), field(L['wb.title_f'], text(s, 'title', { max: 80 })),
        field(L['wb.desc'], text(s, 'description', { area: true, max: 300 })), field(L['wb.image'], imageField(s, 'image_url')), field(L['wb.note'], text(s, 'note', { max: 80, list: noteList() }))];
    }
    if (s.type === 'cta_banner') {
      return [two(field(L['wb.badge'], text(s, 'badge', { max: 30, list: badgeList() })), field(L['wb.icon'], text(s, 'icon', { max: 4 }))), field(L['wb.title_f'], text(s, 'title', { max: 90 })), field(L['wb.text'], text(s, 'text', { area: true, max: 300 })),
        two(field(L['wb.cta_label'], text(s, 'cta_label', { max: 30 })), field(L['wb.cta_url'], text(s, 'cta_url', { max: 500 }))), colorField(s, 'accent_color', L['wb.accent'])];
    }
    if (s.type === 'spacer') return [two(field(L['wb.height'], select(s, 'height', [[24, '24 px'], [48, '48 px'], [80, '80 px']], function (v) { s.height = Number(v); pushPreview(true); })), check(s, 'line', L['wb.line'])), field(L['wb.section_title'], text(s, 'title', { max: 80 }))];
    return [field(L['wb.section_title'], text(s, 'title', { max: 80 })), two(field(L['wb.count'], text(s, 'count', { type: 'number', num: true, min: 1, maxv: 24, max: 2 })), field(L['wb.filter'], select(s, 'filter', [['all', L['wb.f.all']], ['games', L['wb.f.games']], ['mods', L['wb.f.mods']], ['payloads', L['wb.f.payloads']]])))];
  }
  function listEditor(arr, maxN, cols, blank, addLabel, rowTitle) {
    var box = h('div', { class: 'wb-slides' });
    arr.forEach(function (it, i) {
      var row = h('div', { class: 'wb-item' }, [h('div', { class: 'wb-item-h' }, [h('span', { class: 't', text: (i + 1) + '. ' + (rowTitle ? rowTitle(it) : '') }),
        h('button', { type: 'button', class: 'wb-ico', text: '↑', title: L['wb.up'] }), h('button', { type: 'button', class: 'wb-ico', text: '↓', title: L['wb.down'] }), h('button', { type: 'button', class: 'wb-ico', text: '✕', title: L['wb.del'] })])]);
      var fb = h('div', { class: 'wb-fields' });
      cols.forEach(function (c) {
        var el = c.kind === 'image' ? imageField(it, c.k) : c.kind === 'color' ? null : c.kind === 'size' ? select(it, c.k, [['small', L['wb.size.small']], ['medium', L['wb.size.medium']], ['large', L['wb.size.large']]]) : text(it, c.k, { area: c.area, max: c.max || 120, ph: c.ph });
        fb.appendChild(c.kind === 'color' ? colorField(it, c.k, c.label, true) : field(c.label, el));
      });
      row.appendChild(fb);
      var b = row.querySelectorAll('.wb-item-h button');
      b[0].addEventListener('click', function () { if (i > 0) { snap(); arr.splice(i - 1, 0, arr.splice(i, 1)[0]); renderInsp(); pushPreview(true); } });
      b[1].addEventListener('click', function () { if (i < arr.length - 1) { snap(); arr.splice(i + 1, 0, arr.splice(i, 1)[0]); renderInsp(); pushPreview(true); } });
      b[2].addEventListener('click', function () { snap(); arr.splice(i, 1); renderInsp(); pushPreview(true); });
      box.appendChild(row);
    });
    var add = h('button', { type: 'button', class: 'btn ghost small', text: '+ ' + addLabel });
    add.disabled = arr.length >= maxN;
    add.addEventListener('click', function () { if (arr.length >= maxN) return; snap(); arr.push(clone(blank)); renderInsp(); pushPreview(true); });
    return [box, add];
  }
  function noteList() { if (!document.getElementById('wb-notes')) document.body.appendChild(h('datalist', { id: 'wb-notes' }, [L['wb.note_sponsored'], L['wb.note_collab']].map(function (v) { return h('option', { value: v }); }))); return 'wb-notes'; }
  function styleFields(s) {
    var st = s.style;
    var out = [];
    if (s.type === 'rich_text') out.push(colorField(st, 'bg_color', L['wb.bg_color'], true), colorField(st, 'text_color', L['wb.text_color'], true));
    else if (s.type !== 'carousel' && s.type !== 'spacer' && s.type !== 'latest_grid') {
      out.push(colorField(st, 'bg_color', L['wb.bg_color'], true), check(st, 'gradient', L['wb.gradient']));
      if (st.gradient) out.push(colorField(st, 'bg_color2', L['wb.bg_color2'], true));
      out.push(field(L['wb.bg_image'], imageField(st, 'bg_image')), field(L['wb.overlay'], range(st, 'overlay', 0, 100, ' %')), field(L['wb.blur'], range(st, 'blur', 0, 20, ' px')), colorField(st, 'text_color', L['wb.text_color'], true), colorField(st, 'accent', L['wb.accent_block'], true));
    } else out.push(colorField(st, 'accent', L['wb.accent_block'], true));
    out.push(field(L['wb.radius'], range(st, 'radius', 0, 24, ' px')), check(st, 'glow', L['wb.glow']),
      field(L['wb.align'], select(st, 'align', [['left', L['wb.align.left']], ['center', L['wb.align.center']], ['right', L['wb.align.right']]])));
    return out;
  }
  function spaceFields(s) {
    var sp = s.space;
    return [two(field(L['wb.pad_top'], text(sp, 'pad_top', { type: 'number', num: true, min: 0, maxv: 160, max: 3, ph: 'auto' })), field(L['wb.pad_bottom'], text(sp, 'pad_bottom', { type: 'number', num: true, min: 0, maxv: 160, max: 3, ph: 'auto' }))),
      two(field(L['wb.margin_top'], text(sp, 'margin_top', { type: 'number', num: true, min: 0, maxv: 160, max: 3, ph: 'auto' })), field(L['wb.margin_bottom'], text(sp, 'margin_bottom', { type: 'number', num: true, min: 0, maxv: 160, max: 3, ph: 'auto' }))),
      field(L['wb.visibility'], select(sp, 'visibility', [['both', L['wb.vis.both']], ['desktop', L['wb.vis.desktop']], ['mobile', L['wb.vis.mobile']]]))];
  }
  function themeFields() {
    var t = state.site_theme, a = t.announce;
    var radius = h('div', { class: 'wb-up' }), rg = h('input', { type: 'range', min: 0, max: 32, step: 1 }), ro = h('output'), rc = h('button', { type: 'button', class: 'wb-ico', text: '✕', title: L['wb.reset_field'] });
    rg.value = t.radius == null ? 20 : t.radius; ro.textContent = t.radius == null ? 'auto' : t.radius + ' px';
    rg.addEventListener('input', function () { t.radius = Number(rg.value); ro.textContent = rg.value + ' px'; changed(); });
    rc.addEventListener('click', function () { snap(); t.radius = null; rg.value = 20; ro.textContent = 'auto'; pushPreview(true); });
    [rg, ro, rc].forEach(function (x) { radius.appendChild(x); });
    return [h('strong', { text: L['wb.theme.colors'] }), colorField(t, 'accent', L['wb.theme.accent'], true), colorField(t, 'bg_color', L['wb.theme.bg'], true),
      field(L['wb.theme.radius'], radius), field(L['wb.theme.nav'], select(t, 'nav_style', [['default', L['wb.nav.default']], ['solid', L['wb.nav.solid']], ['transparent', L['wb.nav.transparent']], ['blur', L['wb.nav.blur']]])),
      field(L['wb.theme.cards'], select(t, 'card_style', [['glass', L['wb.card.glass']], ['flat', L['wb.card.flat']], ['outline', L['wb.card.outline']]])),
      h('strong', { text: L['wb.theme.announce'] }), check(a, 'active', L['wb.active']), field(L['wb.text'], text(a, 'text', { area: true, max: 200 })),
      two(field(L['wb.cta_label'], text(a, 'link_label', { max: 30 })), field(L['wb.cta_url'], text(a, 'link_url', { max: 500 }))), colorField(a, 'color', L['wb.accent']),
      h('strong', { text: L['wb.ov.title'] + ' (' + Object.keys(state.text_overrides).length + ')' }), overridesList()];
  }

  function overridesList() {
    var box = h('div', { class: 'wb-ovl' }), keys = Object.keys(state.text_overrides);
    if (!keys.length) box.appendChild(h('p', { class: 'wb-hint', text: L['wb.ov.none'] }));
    keys.forEach(function (k) {
      var txt = state.text_overrides[k].replace(/<[^>]*>/g, '');
      var row = h('div', { class: 'wb-ov' }, [h('span', { class: 't', text: txt, title: k }), h('code', { text: k.split('.').slice(0, 2).join('.') }), h('button', { type: 'button', class: 'wb-ico', text: '↺', title: L['wb.ov.reset'] })]);
      row.querySelector('button').addEventListener('click', function () { snap(); delete state.text_overrides[k]; renderInsp(); pushPreview(true); });
      box.appendChild(row);
    });
    return box;
  }

  function renderSide() {
    o.tabBlocks.setAttribute('aria-selected', String(side === 'blocks')); o.tabInsp.setAttribute('aria-selected', String(side === 'insp'));
    o.pBlocks.hidden = side !== 'blocks'; o.pInsp.hidden = side !== 'insp';
    renderBlocks(); renderInsp();
  }
  function renderBlocks() {
    var p = o.pBlocks; p.innerHTML = '';
    p.appendChild(h('p', { class: 'wb-hint', text: PAGES[page].list ? L['wb.palette.hint'] : L['wb.nolist.hint'] }));
    var pal = h('div', { class: 'wb-pal' });
    [['carousel', '🎠'], ['collab_banner', '🤝'], ['spotlight_game', '⭐'], ['latest_grid', '📦'], ['cta_banner', '📣'], ['rich_text', '📝'], ['features_grid', '✨'], ['video', '🎬'], ['faq', '❓'], ['discord_invite', '💬'], ['counters', '📊'], ['gallery', '🖼️'], ['top_creators', '🏆'], ['button_bar', '🔘'], ['spacer', '↕️']].forEach(function (c) {
      var chip = h('div', { class: 'wb-chip', draggable: 'true', 'data-new': c[0], tabindex: '0', role: 'button' }, [h('span', { text: c[1] }), L['wb.type.' + c[0]]]);
      chip.addEventListener('dragstart', function (e) { e.dataTransfer.setData('text/plain', 'new:' + c[0]); e.dataTransfer.effectAllowed = 'copy'; });
      chip.addEventListener('click', function () { addSection(c[0], list().length); });
      chip.addEventListener('keydown', function (e) { if (e.key === 'Enter') addSection(c[0], list().length); });
      pal.appendChild(chip);
    });
    var gs = h('button', { type: 'button', class: 'wb-chip wide', draggable: 'true', 'data-new': 'site_style' }, [h('span', { text: '🎨' }), L['wb.type.site_style']]);
    gs.addEventListener('click', openTheme); pal.appendChild(gs); p.appendChild(pal);
    p.appendChild(h('strong', { text: L['wb.layers'] }));
    var ls = h('div', { class: 'wb-slides' });
    if (!list().length) ls.appendChild(h('p', { class: 'wb-hint', text: L['wb.empty'] }));
    list().forEach(function (s, i) {
      var row = h('div', { class: 'wb-slide' + (s.id === selId ? ' on' : '') }, [h('span', { class: 't', text: L['wb.type.' + s.type] + (s.title ? ' — ' + s.title : '') }),
        h('button', { type: 'button', class: 'wb-ico', text: s.active ? '👁' : '🚫', title: L['wb.active'] }), h('button', { type: 'button', class: 'wb-ico', text: '↑' }), h('button', { type: 'button', class: 'wb-ico', text: '↓' })]);
      var b = row.querySelectorAll('button');
      row.addEventListener('click', function (e) { if (e.target.closest('button')) return; selectBlock(s.id, true); });
      b[0].addEventListener('click', function () { snap(); s.active = !s.active; renderBlocks(); pushPreview(true); });
      b[1].addEventListener('click', function () { if (i > 0) moveSection(s.id, i - 1); });
      b[2].addEventListener('click', function () { if (i < list().length - 1) moveSection(s.id, i + 2); });
      ls.appendChild(row);
    });
    p.appendChild(ls);
    var hid = state.hidden_elements, hbox = h('div', { class: 'wb-slides' });
    p.appendChild(h('strong', { text: L['wb.hidden.title'] + ' (' + hid.length + ')' }));
    if (!hid.length) hbox.appendChild(h('p', { class: 'wb-hint', text: L['wb.hidden.none'] }));
    hid.slice().forEach(function (id) {
      var row = h('div', { class: 'wb-slide' }, [h('span', { class: 't', text: L['wb.el.' + id] || id }), h('button', { type: 'button', class: 'btn ghost small', text: '👁 ' + L['wb.hidden.show'] })]);
      row.querySelector('button').addEventListener('click', function () { snap(); state.hidden_elements = state.hidden_elements.filter(function (x) { return x !== id; }); renderBlocks(); pushPreview(true); });
      hbox.appendChild(row);
    });
    p.appendChild(hbox);
  }
  function renderInsp() {
    var p = o.pInsp; p.innerHTML = '';
    if (page === 'theme') { p.appendChild(h('div', { class: 'wb-insp-head' }, [h('strong', { text: L['wb.type.site_style'] })])); p.appendChild(h('div', { class: 'wb-fields' }, themeFields())); return; }
    var s = cur();
    if (!s) { p.appendChild(h('p', { class: 'wb-hint', text: L['wb.insp.none'] })); return; }
    var head = h('div', { class: 'wb-insp-head' }, [h('strong', { text: L['wb.type.' + s.type] }), h('button', { type: 'button', class: 'wb-ico', text: '⧉', title: L['wb.dup'] }), h('button', { type: 'button', class: 'wb-ico', text: '🗑', title: L['wb.del'] })]);
    head.children[1].addEventListener('click', function () { dupSection(s.id); }); head.children[2].addEventListener('click', function () { delSection(s.id); });
    p.appendChild(head);
    var sub = h('div', { class: 'wb-sub' }, [['content', L['wb.tab.content']], ['style', L['wb.tab.style']], ['space', L['wb.tab.space']]].map(function (t) {
      var b = h('button', { type: 'button', 'aria-selected': String(insp === t[0]), text: t[1] }); b.addEventListener('click', function () { insp = t[0]; renderInsp(); }); return b;
    }));
    p.appendChild(sub);
    p.appendChild(h('div', { class: 'wb-fields' }, insp === 'content' ? contentFields(s) : insp === 'style' ? styleFields(s) : spaceFields(s)));
  }
  function selectBlock(id, scroll) { selId = id; selSlide = ''; if (id) { side = 'insp'; insp = insp || 'content'; } else side = 'blocks'; page = page === 'theme' ? 'home' : page; o.pageSel.value = page; renderSide(); toFrame({ t: 'select', id: id, scroll: !!scroll }); }
  function openTheme() { var was = page; page = 'theme'; o.pageSel.value = 'theme'; side = 'insp'; selId = ''; renderSide(); if (PAGES[was].url.split('#')[0] !== '/') loadFrame(); }

  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data || !e.data.wb || !o.frame || e.source !== o.frame.contentWindow) return;
    var m = e.data;
    if (m.t === 'ready') { toFrame({ t: 'labels', L: { move: L['wb.bar.move'], edit: L['wb.bar.edit'], dup: L['wb.bar.dup'], del: L['wb.bar.del'], drop: L['wb.bar.drop'], p: L['wb.rt.p'], h1: L['wb.rt.h1'], h2: L['wb.rt.h2'], h3: L['wb.rt.h3'], quote: L['wb.rt.quote'], linkPrompt: L['wb.rt.link'], btnLabel: L['wb.rt.btn_label'], btnUrl: L['wb.rt.btn_url'], reset: L['wb.rt.reset'], hide: L['wb.hide'], remove: L['wb.remove'] } }); toFrame({ t: 'textmode', on: textMode }); toFrame({ t: 'restore', y: lastY, id: selId }); }
    else if (m.t === 'scroll') lastY = m.y;
    else if (m.t === 'select') { if (page === 'theme') { page = 'home'; o.pageSel.value = 'home'; } selId = m.id || ''; selSlide = ''; side = selId ? 'insp' : 'blocks'; renderSide(); }
    else if (m.t === 'add') addSection(m.type, m.index);
    else if (m.t === 'move') moveSection(m.id, m.index);
    else if (m.t === 'hide') { if (state.hidden_elements.indexOf(m.id) < 0) { snap(); state.hidden_elements.push(m.id); renderBlocks(); pushPreview(true); setStatus(L['wb.hidden.done'], 'ok'); } }
    else if (m.t === 'dup') dupSection(m.id);
    else if (m.t === 'del') delSection(m.id);
    else if (m.t === 'undo') undo();
    else if (m.t === 'rich') { var rs = list()[findIdx(m.id)]; if (rs) { snap(); rs.html = m.html; pushPreview(false); } }
    else if (m.t === 'override') { snap(); state.text_overrides[m.key] = m.html; if (page === 'theme') renderInsp(); pushPreview(false); setStatus(L['wb.ov.saved'], 'ok'); }
    else if (m.t === 'override_reset') { if (state.text_overrides[m.key] !== undefined) { snap(); delete state.text_overrides[m.key]; if (page === 'theme') renderInsp(); pushPreview(true); } else pushPreview(true); }
    else if (m.t === 'text') {
      var s = list()[findIdx(m.id)]; if (!s) return; snap();
      if (m.slide) { var sl = state.hero_carousel.filter(function (x) { return x.id === m.slide; })[0]; if (sl) sl[m.key] = m.value; }
      else s[m.key] = m.value;
      renderBlocks(); renderInsp(); pushPreview(false);
    }
  });

  function build() {
    o.textBtn = h('button', { type: 'button', class: 'wb-toggle', 'aria-pressed': 'false', text: L['wb.textmode'] + ' (OFF)' });
    o.undo = h('button', { type: 'button', class: 'btn ghost small', text: '↶ ' + L['wb.undo'], disabled: true, title: 'Ctrl+Z' });
    o.reset = h('button', { type: 'button', class: 'btn ghost small', text: L['wb.reset'] });
    o.publish = h('button', { type: 'button', class: 'btn small', text: L['wb.publish'] });
    o.close = h('button', { type: 'button', class: 'btn ghost small', text: '✕ ' + L['wb.close'] });
    o.status = h('span', { class: 'wb-status', role: 'status', 'aria-live': 'polite' });
    o.pageSel = h('select', { 'aria-label': L['wb.page'] }, [['home', L['wb.page.home']], ['catalogue', L['wb.page.catalogue']], ['demandes', L['wb.page.demandes']], ['status', L['wb.page.status']], ['footer', L['wb.page.footer']], ['theme', L['wb.page.theme']]].map(function (x) { return h('option', { value: x[0], text: x[1] }); }));
    var segD = h('button', { type: 'button', 'aria-pressed': 'true', text: '🖥️ ' + L['wb.desktop'] }), segM = h('button', { type: 'button', 'aria-pressed': 'false', text: '📱 ' + L['wb.mobile'] });
    var seg = h('div', { class: 'wb-seg', role: 'group' }, [segD, segM]);
    o.tabBlocks = h('button', { type: 'button', text: '+ ' + L['wb.tab.blocks'] }); o.tabInsp = h('button', { type: 'button', text: '⚙️ ' + L['wb.tab.inspector'] });
    o.pBlocks = h('div', { class: 'wb-panel' }); o.pInsp = h('div', { class: 'wb-panel' });
    o.frame = h('iframe', { title: L['wb.canvas'], src: 'about:blank' });
    o.canvas = h('div', { class: 'wb-canvas' }, [o.frame]);
    o.root = h('div', { class: 'wb', role: 'dialog', 'aria-modal': 'true', 'aria-label': L['wb.title'] }, [
      h('div', { class: 'wb-top' }, [o.close, h('strong', { text: L['wb.title'] }), o.pageSel, seg, o.textBtn, o.undo, o.reset, h('span', { class: 'sep' }), o.status, o.publish]),
      h('div', { class: 'wb-main' }, [h('div', { class: 'wb-side' }, [h('div', { class: 'wb-tabs', role: 'tablist' }, [o.tabBlocks, o.tabInsp]), o.pBlocks, o.pInsp]), o.canvas])
    ]);
    document.body.appendChild(o.root);
    o.tabBlocks.addEventListener('click', function () { side = 'blocks'; renderSide(); });
    o.tabInsp.addEventListener('click', function () { side = 'insp'; renderSide(); });
    segD.addEventListener('click', function () { view = 'desktop'; segD.setAttribute('aria-pressed', 'true'); segM.setAttribute('aria-pressed', 'false'); o.canvas.classList.remove('is-mobile'); });
    segM.addEventListener('click', function () { view = 'mobile'; segM.setAttribute('aria-pressed', 'true'); segD.setAttribute('aria-pressed', 'false'); o.canvas.classList.add('is-mobile'); });
    o.pageSel.addEventListener('change', function () { page = o.pageSel.value; selId = ''; selSlide = ''; side = page === 'theme' ? 'insp' : 'blocks'; renderSide(); lastY = 0; loadFrame(); });
    o.textBtn.addEventListener('click', function () { textMode = !textMode; o.textBtn.setAttribute('aria-pressed', String(textMode)); o.textBtn.textContent = L['wb.textmode'] + (textMode ? ' (ON)' : ' (OFF)'); toFrame({ t: 'textmode', on: textMode }); });
    o.undo.addEventListener('click', undo);
    o.reset.addEventListener('click', function () { if (!confirm(L['wb.confirm_reset'])) return; state = clone(saved); hist = []; o.undo.disabled = true; selId = ''; renderSide(); pushPreview(true); });
    o.close.addEventListener('click', closeEditor);
    o.publish.addEventListener('click', function () {
      o.publish.disabled = true; setStatus(L['wb.saving']);
      fetch('/dashboard/homepage', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': D.csrf }, body: JSON.stringify(state) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (r) { if (!r.ok) { setStatus(r.d.erreur || L['wb.error'], 'err'); return; } saved = normalize(clone(r.d.homepage)); state = clone(saved); hist = []; o.undo.disabled = true; setStatus(L['wb.published'], 'ok'); renderSide(); })
        .catch(function () { setStatus(L['wb.error'], 'err'); }).then(function () { o.publish.disabled = false; });
    });
    document.addEventListener('keydown', function (e) {
      if (!o.root.classList.contains('is-open')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '')) { e.preventDefault(); undo(); }
      else if (e.key === 'Escape' && !document.activeElement.closest('.wb-fields')) closeEditor();
    });
  }
  function openEditor() { if (!o.root) build(); o.root.classList.add('is-open'); document.body.style.overflow = 'hidden'; renderSide(); loadFrame(); }
  function closeEditor() { o.root.classList.remove('is-open'); document.body.style.overflow = ''; }
  var openBtn = document.getElementById('wb-open');
  if (openBtn) openBtn.addEventListener('click', openEditor);
  if (location.hash === '#vitrine-editor') { var tryOpen = function () { if (openBtn) openEditor(); }; tryOpen(); }
})();
