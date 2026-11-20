(function () {
  'use strict';
  var form = document.getElementById('form-submit');
  if (!form) return;
  var T = {};
  try { T = JSON.parse(document.getElementById('data-i18n').textContent); } catch (e) {  }
  function tr(k, vars) { var s = T[k] != null ? T[k] : k; if (vars) Object.keys(vars).forEach(function (v) { s = s.split('{' + v + '}').join(vars[v]); }); return s; }
  var meta = document.querySelector('meta[name="csrf-token"]');
  var token = meta ? meta.getAttribute('content') : '';
  var f = form.elements;
  var ID_RE = /^[A-Z]{4}[0-9]{5}$/;

  function applyType() {
    var t = f.resource_type.value;
    document.getElementById('parent-field').hidden = !(t === 'update' || t === 'dlc');
    var mod = document.getElementById('mod-fields');
    var isMod = t === 'plugin' || t === 'payload';
    mod.hidden = !isMod; mod.style.display = isMod ? 'grid' : 'none';
    if (t === 'payload') f.pc_target.value = 'payload';
    applyRegions();
  }
  function applyRegions() {
    var r = f.pc_regions.value;
    document.querySelector('[data-region="eu"]').style.display = r === 'US' ? 'none' : '';
    document.querySelector('[data-region="us"]').style.display = r === 'EU' ? 'none' : '';
  }
  f.resource_type.addEventListener('change', applyType);
  f.pc_regions.addEventListener('change', applyRegions);
  applyType();

  var mediaBtn = document.getElementById('media-fetch'), mediaStatus = document.getElementById('media-status'), running = false;
  function compact(v) { return String(v || '').replace(/\s+/g, '').toUpperCase(); }
  function runMedia(auto) {
    if (running) return;
    var raw = f.title_id.value.trim(), cid = compact(raw), tid = ID_RE.test(cid) ? cid : '', title = f.titre.value.trim() || (tid ? '' : raw);
    if (!tid && !title) { if (!auto) mediaStatus.textContent = tr('dash.js.media_need'); return; }
    running = true; mediaBtn.disabled = true; mediaStatus.textContent = tr('dash.js.media_running');
    fetch('/api/submit/fetch-media', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify({ title_id: tid || raw, title: tid ? f.titre.value.trim() : title }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) { mediaStatus.textContent = res.d.erreur || tr('dash.js.media_failed'); return; }
        var d = res.d, n = 0;
        function put(el, v) { if (v && (!auto || !el.value.trim())) { el.value = v; n++; } }
        put(f.titre, d.title); put(f.description, d.description); put(f.icon_url, d.cover); put(f.youtube_url, d.youtube_url);
        if (d.screenshots && d.screenshots.length && (!auto || !f.screenshots.value.trim())) { f.screenshots.value = d.screenshots.join('\n'); n++; }
        if (d.title_id && !tid) f.title_id.value = d.title_id;
        if (n) document.getElementById('advanced').open = true;
        mediaStatus.textContent = n ? tr('dash.js.media_done') : tr('dash.js.media_none');
      })
      .catch(function () { mediaStatus.textContent = tr('dash.js.net_error'); })
      .then(function () { running = false; mediaBtn.disabled = false; });
  }
  mediaBtn.addEventListener('click', function () { runMedia(false); });
  f.title_id.addEventListener('change', function () { var c = compact(f.title_id.value); if (ID_RE.test(c)) { f.title_id.value = c; runMedia(true); } });

})();
