/* Outs Tracker — vanilla JS, no build step. All data lives in localStorage. */
(function () {
  'use strict';

  var STORAGE_KEY = 'outsTracker.v1';
  var STALE_DAYS = 7;          // dirty outs with a last sale more than this many days ago are "stale"
  var DAY_MS = 24 * 60 * 60 * 1000;

  var $ = function (id) { return document.getElementById(id); };

  // ---------- State ----------

  var storageOk = true;
  var outs = loadFromStorage();
  var ui = { view: 'open', search: '', type: 'all', sort: 'logged-desc' };
  var editingId = null;
  var lastDirtyOnHand = '';

  // ---------- Date helpers ----------

  function pad(value, len) {
    var s = String(value);
    while (s.length < len) s = '0' + s;
    return s;
  }

  // Local calendar date -> "YYYY-MM-DD"
  function dateToISODate(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2);
  }

  function todayISODate() { return dateToISODate(new Date()); }

  // "YYYY-MM-DD" -> Date at local midnight (avoids the UTC shift of new Date("YYYY-MM-DD"))
  function parseISODate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    return (d.getMonth() === +m[2] - 1 && d.getDate() === +m[3]) ? d : null;
  }

  function daysSince(isoDate) {
    var d = parseISODate(isoDate);
    if (!d) return null;
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((today - d) / DAY_MS);
  }

  var US_DATE = { month: 'short', day: 'numeric', year: 'numeric' };

  // Accepts "YYYY-MM-DD" or a full ISO timestamp; returns e.g. "Nov 10, 2026"
  function formatDate(iso) {
    if (!iso) return '';
    var d = parseISODate(iso) || new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-US', US_DATE);
  }

  function daysAgoText(n) {
    if (n === null) return '';
    if (n <= 0) return 'today';
    return n === 1 ? '1 day ago' : n + ' days ago';
  }

  // ---------- Record helpers ----------

  function makeId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function buildLocationCode(aisle, bay, shelf) {
    return pad(aisle, 2) + '-' + pad(bay, 3) + '-' + pad(shelf, 3);
  }

  function isStale(o) {
    if (o.type !== 'dirty') return false;
    var n = daysSince(o.lastSaleDate);
    return n !== null && n > STALE_DAYS;
  }

  // Cleans up a record from storage or an import file. Returns null if it can't be used.
  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var aisle = raw.aisle, bay = raw.bay, shelf = raw.shelf;
    if ((aisle == null || bay == null || shelf == null) && typeof raw.locationCode === 'string') {
      var parts = raw.locationCode.split('-');
      if (parts.length === 3) { aisle = parts[0]; bay = parts[1]; shelf = parts[2]; }
    }
    aisle = String(aisle == null ? '' : aisle).trim();
    bay = String(bay == null ? '' : bay).trim();
    shelf = String(shelf == null ? '' : shelf).trim();
    if (!/^\d{1,2}$/.test(aisle) || !/^\d{1,3}$/.test(bay) || !/^\d{1,3}$/.test(shelf)) return null;

    var sku = String(raw.sku == null ? '' : raw.sku).trim();
    if (!sku) return null;

    var type = raw.type === 'dirty' ? 'dirty' : 'clean';
    var onHand = type === 'dirty' ? Math.max(0, Math.floor(Number(raw.onHand)) || 0) : 0;
    var loggedAt = raw.loggedAt && !isNaN(new Date(raw.loggedAt)) ? new Date(raw.loggedAt).toISOString() : new Date().toISOString();
    var resolvedAt = raw.resolvedAt && !isNaN(new Date(raw.resolvedAt)) ? new Date(raw.resolvedAt).toISOString() : null;

    return {
      id: raw.id ? String(raw.id) : makeId(),
      sku: sku,
      type: type,
      onHand: onHand,
      aisle: pad(aisle, 2),
      bay: pad(bay, 3),
      shelf: pad(shelf, 3),
      locationCode: buildLocationCode(aisle, bay, shelf),
      overheadLocation: type === 'dirty' ? String(raw.overheadLocation || '').trim() : '',
      lastSaleDate: type === 'dirty' && parseISODate(raw.lastSaleDate) ? raw.lastSaleDate : '',
      notes: String(raw.notes || '').trim(),
      loggedAt: loggedAt,
      resolvedAt: resolvedAt,
      sample: raw.sample === true
    };
  }

  function normalizeList(list) {
    var seen = {};
    var result = [];
    (Array.isArray(list) ? list : []).forEach(function (raw) {
      var o = normalize(raw);
      if (!o) return;
      if (seen[o.id]) o.id = makeId();
      seen[o.id] = true;
      result.push(o);
    });
    return result;
  }

  // ---------- Storage ----------

  function loadFromStorage() {
    try {
      var text = window.localStorage.getItem(STORAGE_KEY);
      if (!text) return [];
      var data = JSON.parse(text);
      return normalizeList(Array.isArray(data) ? data : data.outs);
    } catch (e) {
      storageOk = false;
      return [];
    }
  }

  function save() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, outs: outs }));
      storageOk = true;
    } catch (e) {
      storageOk = false;
    }
    $('storageWarn').hidden = storageOk;
  }

  // ---------- Filtering & sorting ----------

  function matchesSearch(o, q) {
    if (!q) return true;
    var unpadded = Number(o.aisle) + '-' + Number(o.bay) + '-' + Number(o.shelf);
    return o.sku.toLowerCase().indexOf(q) !== -1 ||
           o.locationCode.indexOf(q) !== -1 ||
           unpadded.indexOf(q) !== -1;
  }

  function byLocation(a, b) {
    return (Number(a.aisle) - Number(b.aisle)) ||
           (Number(a.bay) - Number(b.bay)) ||
           (Number(a.shelf) - Number(b.shelf));
  }

  function byNewest(a, b) {
    return a.loggedAt < b.loggedAt ? 1 : a.loggedAt > b.loggedAt ? -1 : 0;
  }

  var SORTERS = {
    'logged-desc': byNewest,
    'logged-asc': function (a, b) { return byNewest(b, a); },
    'location': function (a, b) { return byLocation(a, b) || byNewest(a, b); },
    'sku': function (a, b) {
      return a.sku.localeCompare(b.sku, 'en', { numeric: true, sensitivity: 'base' }) || byLocation(a, b);
    },
    // Longest since last sale first; clean outs (no sale date) go to the end.
    'stale': function (a, b) {
      var da = a.type === 'dirty' ? daysSince(a.lastSaleDate) : null;
      var db = b.type === 'dirty' ? daysSince(b.lastSaleDate) : null;
      if (da === null && db === null) return byLocation(a, b);
      if (da === null) return 1;
      if (db === null) return -1;
      return (db - da) || byLocation(a, b);
    }
  };

  function inView(o) {
    return ui.view === 'open' ? !o.resolvedAt : !!o.resolvedAt;
  }

  function getVisible() {
    var q = ui.search.trim().toLowerCase();
    return outs
      .filter(function (o) {
        return inView(o) && (ui.type === 'all' || o.type === ui.type) && matchesSearch(o, q);
      })
      .sort(SORTERS[ui.sort] || byNewest);
  }

  // ---------- Rendering ----------

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function cardHTML(o) {
    var open = !o.resolvedAt;
    var dirty = o.type === 'dirty';
    var stale = open && isStale(o);
    var days = dirty ? daysSince(o.lastSaleDate) : null;

    var badges = '<span class="badge ' + (dirty ? 'badge-dirty' : 'badge-clean') + '">' + (dirty ? 'Dirty' : 'Clean') + '</span>';
    if (stale) badges += '<span class="badge badge-stale">Stale</span>';
    if (o.sample) badges += '<span class="badge badge-sample">Sample</span>';

    var facts =
      '<div><dt>SKU</dt><dd class="sku">' + esc(o.sku) + '</dd></div>' +
      '<div><dt>On hand</dt><dd>' + esc(o.onHand) + '</dd></div>';

    if (dirty) {
      facts +=
        '<div class="wide"><dt>Overhead location</dt><dd>' + esc(o.overheadLocation || '—') + '</dd></div>' +
        '<div class="wide stale-row"><dt>Last sale</dt><dd>' +
          (o.lastSaleDate
            ? esc(formatDate(o.lastSaleDate)) + ' · <span class="days">' + esc(daysAgoText(days)) + '</span>'
            : '—') +
        '</dd></div>';
    }

    facts += '<div><dt>Logged</dt><dd>' + esc(formatDate(o.loggedAt)) + '</dd></div>';
    if (!open) facts += '<div><dt>Resolved</dt><dd>' + esc(formatDate(o.resolvedAt)) + '</dd></div>';

    var actions = open
      ? '<div class="actions">' +
          '<button type="button" class="btn btn-primary" data-act="resolve">Resolved</button>' +
          '<button type="button" class="btn" data-act="edit">Edit</button>' +
          '<button type="button" class="btn btn-danger" data-act="delete">Delete</button>' +
        '</div>'
      : '<div class="actions two">' +
          '<button type="button" class="btn" data-act="reopen">Reopen</button>' +
          '<button type="button" class="btn btn-danger" data-act="delete">Delete</button>' +
        '</div>';

    return '<li class="card' + (dirty ? ' is-dirty' : '') + (stale ? ' is-stale' : '') + '" data-id="' + esc(o.id) + '">' +
      '<div class="card-head">' +
        '<div><span class="loc-label">Shelf location</span><span class="loc">' + esc(o.locationCode) + '</span></div>' +
        '<div class="badges">' + badges + '</div>' +
      '</div>' +
      '<dl class="facts">' + facts + '</dl>' +
      (o.notes ? '<p class="notes">' + esc(o.notes) + '</p>' : '') +
      actions +
    '</li>';
  }

  function render() {
    var openOuts = outs.filter(function (o) { return !o.resolvedAt; });
    var resolvedCount = outs.length - openOuts.length;
    var dirtyCount = openOuts.filter(function (o) { return o.type === 'dirty'; }).length;

    $('countOpen').textContent = openOuts.length;
    $('countDirty').textContent = dirtyCount;
    $('countClean').textContent = openOuts.length - dirtyCount;

    $('tabOpen').textContent = 'Open (' + openOuts.length + ')';
    $('tabResolved').textContent = 'Resolved (' + resolvedCount + ')';

    var visible = getVisible();
    var totalInView = ui.view === 'open' ? openOuts.length : resolvedCount;
    var label = ui.view === 'open' ? 'open' : 'resolved';

    $('list').innerHTML = visible.map(cardHTML).join('');

    var filtered = ui.type !== 'all' || ui.search.trim() !== '';
    $('resultInfo').textContent = totalInView === 0 ? '' :
      filtered ? 'Showing ' + visible.length + ' of ' + totalInView + ' ' + label + ' outs'
               : totalInView + ' ' + label + (totalInView === 1 ? ' out' : ' outs');

    var empty = $('empty');
    empty.hidden = visible.length > 0;
    if (visible.length === 0) {
      empty.textContent = totalInView > 0 ? 'No outs match this search or filter.' :
        ui.view === 'open' ? 'No open outs. Tap “Add Out” to log an empty shelf spot.'
                           : 'Nothing resolved yet. Resolved outs show up here.';
    }
  }

  var toastTimer = null;
  function toast(message) {
    var el = $('toast');
    el.textContent = message;
    el.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-on'); }, 2600);
  }

  // ---------- Add / Edit form ----------

  var dialog = $('formDialog');
  var form = $('outForm');
  var ERROR_FIELDS = ['fSku', 'fOnHand', 'fOverhead', 'fLastSale'];

  function currentType() {
    return form.elements.outType.value === 'dirty' ? 'dirty' : 'clean';
  }

  function setType(type) {
    Array.prototype.forEach.call(form.elements.outType, function (radio) {
      radio.checked = radio.value === type;
    });
    applyType();
  }

  // Shows/hides the dirty-only fields and locks on-hand at 0 for clean outs.
  function applyType() {
    var dirty = currentType() === 'dirty';
    var onHand = $('fOnHand');
    $('dirtyFields').hidden = !dirty;
    if (dirty) {
      if (onHand.disabled) onHand.value = lastDirtyOnHand;
      onHand.disabled = false;
      $('onHandHint').textContent = 'Units in the store (overheads, backstock). Must be more than 0.';
    } else {
      if (!onHand.disabled) lastDirtyOnHand = onHand.value;
      onHand.value = '0';
      onHand.disabled = true;
      $('onHandHint').textContent = 'Locked at 0 — clean outs have nothing on hand.';
    }
    updateLastSaleHint();
  }

  function updateLocPreview() {
    var a = $('fAisle').value.trim(), b = $('fBay').value.trim(), s = $('fShelf').value.trim();
    var ok = /^\d{1,2}$/.test(a) && /^\d{1,3}$/.test(b) && /^\d{1,3}$/.test(s);
    $('locPreview').textContent = ok ? 'Saves as ' + buildLocationCode(a, b, s) : '';
  }

  function updateLastSaleHint() {
    var n = daysSince($('fLastSale').value);
    $('lastSaleHint').textContent = (n === null || n < 0) ? '' :
      'Last sold ' + daysAgoText(n) + (n > STALE_DAYS ? ' — stale (over ' + STALE_DAYS + ' days)' : '');
  }

  function clearErrors() {
    ERROR_FIELDS.forEach(function (id) {
      $('err-' + id).textContent = '';
      $(id).removeAttribute('aria-invalid');
    });
    $('err-loc').textContent = '';
    ['fAisle', 'fBay', 'fShelf'].forEach(function (id) { $(id).removeAttribute('aria-invalid'); });
  }

  function openForm(id) {
    editingId = id || null;
    var o = editingId ? outs.filter(function (x) { return x.id === editingId; })[0] : null;
    form.reset();
    clearErrors();
    lastDirtyOnHand = '';

    $('formTitle').textContent = o ? 'Edit Out' : 'Add Out';
    $('saveBtn').textContent = o ? 'Save changes' : 'Save out';
    $('fLastSale').max = todayISODate();
    $('fOnHand').disabled = false;

    if (o) {
      $('fSku').value = o.sku;
      $('fAisle').value = o.aisle;
      $('fBay').value = o.bay;
      $('fShelf').value = o.shelf;
      $('fOverhead').value = o.overheadLocation;
      $('fLastSale').value = o.lastSaleDate;
      $('fNotes').value = o.notes;
      if (o.type === 'dirty') $('fOnHand').value = o.onHand;
      setType(o.type);
    } else {
      setType('clean');
    }
    updateLocPreview();

    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    $('fSku').focus();
  }

  function closeForm() {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    editingId = null;
  }

  // Validates the form. Returns { values } or { errors, firstInvalid }.
  function readForm() {
    var errors = {};
    var first = null;
    function fail(key, inputId, message) {
      if (!errors[key]) errors[key] = message;
      $(inputId).setAttribute('aria-invalid', 'true');
      if (!first) first = inputId;
    }

    var type = currentType();
    var sku = $('fSku').value.trim();
    if (!sku) fail('fSku', 'fSku', 'Enter a SKU.');

    var aisle = $('fAisle').value.trim();
    var bay = $('fBay').value.trim();
    var shelf = $('fShelf').value.trim();
    var locMsg = 'Shelf location needs all three parts: Aisle (1–2 digits), Bay and Shelf (up to 3 digits each).';
    if (!/^\d{1,2}$/.test(aisle)) fail('loc', 'fAisle', locMsg);
    if (!/^\d{1,3}$/.test(bay)) fail('loc', 'fBay', locMsg);
    if (!/^\d{1,3}$/.test(shelf)) fail('loc', 'fShelf', locMsg);

    var onHand = 0, overhead = '', lastSale = '';
    if (type === 'dirty') {
      var rawOnHand = $('fOnHand').value.trim();
      onHand = Number(rawOnHand);
      if (rawOnHand === '' || !Number.isInteger(onHand) || onHand <= 0) {
        fail('fOnHand', 'fOnHand', 'Dirty outs need a whole-number on-hand count greater than 0.');
      }
      overhead = $('fOverhead').value.trim();
      if (!overhead) fail('fOverhead', 'fOverhead', 'Enter where the product is stored.');

      lastSale = $('fLastSale').value;
      var n = daysSince(lastSale);
      if (n === null) fail('fLastSale', 'fLastSale', 'Pick the last sale date.');
      else if (n < 0) fail('fLastSale', 'fLastSale', 'Last sale date can’t be in the future.');
    }

    if (first) return { errors: errors, firstInvalid: first };
    return {
      values: {
        sku: sku, type: type, onHand: onHand,
        aisle: pad(aisle, 2), bay: pad(bay, 3), shelf: pad(shelf, 3),
        locationCode: buildLocationCode(aisle, bay, shelf),
        overheadLocation: overhead, lastSaleDate: lastSale,
        notes: $('fNotes').value.trim()
      }
    };
  }

  function submitForm(event) {
    event.preventDefault();
    clearErrors();
    var result = readForm();

    if (result.errors) {
      ERROR_FIELDS.forEach(function (id) {
        if (result.errors[id]) $('err-' + id).textContent = result.errors[id];
      });
      if (result.errors.loc) $('err-loc').textContent = result.errors.loc;
      $(result.firstInvalid).focus();
      return;
    }

    var v = result.values;
    var existing = editingId ? outs.filter(function (x) { return x.id === editingId; })[0] : null;
    if (existing) {
      Object.keys(v).forEach(function (key) { existing[key] = v[key]; });
      toast('Updated ' + v.locationCode);
    } else {
      v.id = makeId();
      v.loggedAt = new Date().toISOString();
      v.resolvedAt = null;
      v.sample = false;
      outs.push(v);
      toast('Logged ' + v.type + ' out at ' + v.locationCode);
    }
    save();
    closeForm();
    render();
  }

  // ---------- Card actions ----------

  function onListClick(event) {
    var btn = event.target.closest('button[data-act]');
    if (!btn) return;
    var id = btn.closest('.card').getAttribute('data-id');
    var o = outs.filter(function (x) { return x.id === id; })[0];
    if (!o) return;

    switch (btn.getAttribute('data-act')) {
      case 'edit':
        openForm(id);
        return;
      case 'resolve':
        o.resolvedAt = new Date().toISOString();
        toast('Resolved ' + o.locationCode + ' — moved to Resolved');
        break;
      case 'reopen':
        o.resolvedAt = null;
        toast('Reopened ' + o.locationCode);
        break;
      case 'delete':
        if (!window.confirm('Delete the out at ' + o.locationCode + ' (SKU ' + o.sku + ')?\n\nThis cannot be undone.')) return;
        outs = outs.filter(function (x) { return x.id !== id; });
        toast('Deleted ' + o.locationCode);
        break;
      default:
        return;
    }
    save();
    render();
  }

  // ---------- Export / import ----------

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function exportJSON() {
    var payload = {
      app: 'outs-tracker',
      version: 1,
      exportedAt: new Date().toISOString(),
      outs: outs
    };
    download('outs-backup-' + todayISODate() + '.json', JSON.stringify(payload, null, 2), 'application/json');
    toast('Exported ' + outs.length + ' outs (open and resolved)');
  }

  function csvCell(value) {
    var s = value == null ? '' : String(value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // Exports exactly what's on screen: current tab, search, filter and sort order.
  function exportCSV() {
    var rows = getVisible();
    if (!rows.length) { toast('Nothing in the current list to export'); return; }
    var header = ['Shelf Location', 'Aisle', 'Bay', 'Shelf', 'SKU', 'Type', 'On Hand',
                  'Overhead Location', 'Last Sale Date', 'Days Since Last Sale',
                  'Date Logged', 'Status', 'Date Resolved', 'Notes'];
    var lines = [header.join(',')];
    rows.forEach(function (o) {
      var days = o.type === 'dirty' ? daysSince(o.lastSaleDate) : null;
      lines.push([
        o.locationCode, o.aisle, o.bay, o.shelf, o.sku,
        o.type === 'dirty' ? 'Dirty' : 'Clean', o.onHand,
        o.overheadLocation, formatDate(o.lastSaleDate), days === null ? '' : days,
        formatDate(o.loggedAt), o.resolvedAt ? 'Resolved' : 'Open', formatDate(o.resolvedAt), o.notes
      ].map(csvCell).join(','));
    });
    download('outs-' + ui.view + '-' + todayISODate() + '.csv', lines.join('\r\n'), 'text/csv');
    toast('Exported ' + rows.length + ' rows to CSV');
  }

  function importJSON(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var incoming;
      try {
        var data = JSON.parse(reader.result);
        incoming = normalizeList(Array.isArray(data) ? data : data && data.outs);
      } catch (e) {
        window.alert('That file isn’t a valid Outs Tracker JSON backup.');
        return;
      }
      if (!incoming.length) {
        window.alert('No usable outs were found in that file.');
        return;
      }
      if (outs.length && !window.confirm(
        'Replace the ' + outs.length + ' outs on this device with the ' + incoming.length +
        ' outs in this file?\n\nTap Cancel to keep what you have.')) {
        return;
      }
      outs = incoming;
      save();
      render();
      toast('Imported ' + incoming.length + ' outs');
    };
    reader.onerror = function () { window.alert('Couldn’t read that file.'); };
    reader.readAsText(file);
  }

  // ---------- Sample data ----------

  function isoDateDaysAgo(n) {
    var d = new Date();
    d.setDate(d.getDate() - n);
    return dateToISODate(d);
  }

  function buildSamples() {
    var now = Date.now();
    return normalizeList([
      {
        id: 'sample-1', sample: true, sku: '4471208', type: 'dirty', onHand: 6,
        aisle: '17', bay: '4', shelf: '56',
        overheadLocation: 'Overhead above bay 004', lastSaleDate: isoDateDaysAgo(3),
        notes: 'Sample: dirty out, sold a few days ago.',
        loggedAt: new Date(now - 60 * 60 * 1000).toISOString()
      },
      {
        id: 'sample-2', sample: true, sku: '8830145', type: 'dirty', onHand: 12,
        aisle: '3', bay: '112', shelf: '9',
        overheadLocation: 'Backstock rack B, top shelf', lastSaleDate: isoDateDaysAgo(12),
        notes: 'Sample: stale dirty out, last sale over a week ago.',
        loggedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString()
      },
      {
        id: 'sample-3', sample: true, sku: '2209917', type: 'clean', onHand: 0,
        aisle: '22', bay: '7', shelf: '31',
        notes: 'Sample: clean out, nothing on hand.',
        loggedAt: new Date(now - 3 * 60 * 60 * 1000).toISOString()
      }
    ]);
  }

  function loadSamples() {
    var real = outs.filter(function (o) { return !o.sample; });
    if (real.length && !window.confirm(
      'You have ' + real.length + ' real outs saved.\n\nAdd 3 sample outs alongside them? ' +
      'They are tagged SAMPLE and can be deleted individually.')) {
      return;
    }
    outs = real.concat(buildSamples());   // reloading replaces old samples instead of duplicating them
    save();
    ui.view = 'open';
    syncControls();
    render();
    toast('Loaded 3 sample outs');
  }

  function clearAll() {
    if (!outs.length) { toast('Nothing to clear'); return; }
    if (!window.confirm(
      'Clear ALL data — ' + outs.length + ' outs, open and resolved?\n\n' +
      'This cannot be undone. Export a JSON backup first if you need one.')) {
      return;
    }
    outs = [];
    save();
    render();
    toast('All data cleared');
  }

  // ---------- Controls wiring ----------

  function syncControls() {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
      var on = tab.getAttribute('data-view') === ui.view;
      tab.classList.toggle('is-on', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Array.prototype.forEach.call(document.querySelectorAll('.seg-btn'), function (btn) {
      var on = btn.getAttribute('data-type') === ui.type;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  // Jump to the next location box once the current one is full.
  function autoAdvance(fromId, toId, len) {
    $(fromId).addEventListener('input', function () {
      this.value = this.value.replace(/\D/g, '');
      if (this.value.length >= len) $(toId).focus();
    });
  }

  function init() {
    $('storageWarn').hidden = storageOk;

    document.querySelector('.tabs').addEventListener('click', function (e) {
      var tab = e.target.closest('.tab');
      if (!tab) return;
      ui.view = tab.getAttribute('data-view');
      syncControls();
      render();
    });

    document.querySelector('.seg').addEventListener('click', function (e) {
      var btn = e.target.closest('.seg-btn');
      if (!btn) return;
      ui.type = btn.getAttribute('data-type');
      syncControls();
      render();
    });

    $('search').addEventListener('input', function () { ui.search = this.value; render(); });
    $('sort').addEventListener('change', function () { ui.sort = this.value; render(); });

    $('list').addEventListener('click', onListClick);
    $('addBtn').addEventListener('click', function () { openForm(null); });

    form.addEventListener('submit', submitForm);
    $('cancelBtn').addEventListener('click', closeForm);
    $('cancelTop').addEventListener('click', closeForm);
    Array.prototype.forEach.call(form.elements.outType, function (radio) {
      radio.addEventListener('change', applyType);
    });

    autoAdvance('fAisle', 'fBay', 2);
    autoAdvance('fBay', 'fShelf', 3);
    $('fShelf').addEventListener('input', function () { this.value = this.value.replace(/\D/g, ''); });
    ['fAisle', 'fBay', 'fShelf'].forEach(function (id) { $(id).addEventListener('input', updateLocPreview); });
    $('fLastSale').addEventListener('input', updateLastSaleHint);

    $('exportJson').addEventListener('click', exportJSON);
    $('exportCsv').addEventListener('click', exportCSV);
    $('importBtn').addEventListener('click', function () { $('importFile').click(); });
    $('importFile').addEventListener('change', function () {
      if (this.files && this.files[0]) importJSON(this.files[0]);
      this.value = '';
    });
    $('loadSamples').addEventListener('click', loadSamples);
    $('clearAll').addEventListener('click', clearAll);

    // "Days since last sale" depends on today's date, so refresh when the app comes back to the foreground.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) render();
    });

    render();

    // Offline support when served over http(s). Skipped for file:// where service workers aren't allowed.
    if ('serviceWorker' in navigator && /^https?:$/.test(window.location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* app still works online */ });
    }
  }

  init();
})();
