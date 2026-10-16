const STORAGE_KEY = "dfixer-orderguard-v1";
const ACTOR = "Rani Admin";
const CURRENT_USER_KEY = "dfixer-orderguard-user";
const VIEW_LABELS = {
  dashboard: "Ringkasan",
  manifests: "Manifest",
  imports: "Impor data",
  incidents: "Insiden",
  reports: "Laporan",
  audit: "Audit log",
};
const ROLE_PERMISSIONS = {
  'super-admin': ['dashboard', 'manifests', 'imports', 'incidents', 'reports', 'audit'],
  'store-admin': ['dashboard', 'manifests', 'imports', 'incidents', 'reports', 'audit'],
  'handover-staff': ['dashboard', 'manifests'],
};
const ROLE_LABELS = {
  'super-admin': 'Platform Admin',
  'store-admin': 'Store Admin',
  'handover-staff': 'Handover Staff',
};
const MANIFEST_LABELS = {
  DRAFT: "Draft",
  READY: "Siap",
  OPEN: "Terbuka",
  HANDOVER_IN_PROGRESS: "Pemindaian berlangsung",
  RECONCILIATION_REQUIRED: "Rekonsiliasi",
  PARTIALLY_HANDED_OVER: "Diterima sebagian",
  READY_FOR_CONFIRMATION: "Siap dikonfirmasi",
  CONFIRMED: "Terkonfirmasi",
  CLOSED: "Ditutup",
  CANCELLED: "Dibatalkan",
};
const PACKAGE_LABELS = {
  EXPECTED: "Belum dipindai",
  SCANNED: "Dipindai",
  EXCEPTION: "Pengecualian",
  HANDED_OVER: "Diterima kurir",
  REJECTED: "Ditolak kurir",
  CANCELLED: "Dibatalkan",
};
const SCAN_LABELS = {
  MATCH: "Cocok",
  DUPLICATE_SCAN: "Pindai duplikat",
  NOT_IN_MANIFEST: "Di luar manifest",
  ALREADY_HANDED_OVER: "Sudah diserahkan",
  INVALID_PACKAGE: "Kode tidak dikenal",
  CANCELLED: "Paket dibatalkan",
};

const todayISO = () => new Date().toISOString().slice(0, 10);
const nowISO = () => new Date().toISOString();
const makeId = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}`;
const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));
const normalize = (value = "") => String(value).trim().toLocaleLowerCase("id-ID");
const trackingScope = (tracking, shop, courier, date) => [normalize(tracking), normalize(shop), normalize(courier), date].join("|");
const formatDate = (value) => value ? new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value.slice(0, 10)}T12:00:00`)) : "-";
const formatDateTime = (value) => value ? new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "-";
const statusClass = (status) => ({
  OPEN: "open", HANDOVER_IN_PROGRESS: "in-progress", PARTIALLY_HANDED_OVER: "partial",
  RECONCILIATION_REQUIRED: "required", READY_FOR_CONFIRMATION: "ready", CONFIRMED: "confirmed",
  CLOSED: "closed", CANCELLED: "cancelled", RESOLVED: "confirmed", MATCH: "confirmed",
  DUPLICATE_SCAN: "partial", NOT_IN_MANIFEST: "exception", ALREADY_HANDED_OVER: "exception",
  INVALID_PACKAGE: "exception", EXPECTED: "required", SCANNED: "open", HANDED_OVER: "confirmed",
  REJECTED: "exception",
}[status] || "");

function sampleState() {
  const today = todayISO();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const firstId = `OG-${today.replaceAll("-", "").slice(2)}-042`;
  const secondId = `OG-${yesterday.replaceAll("-", "").slice(2)}-039`;
  const firstPackages = [
    ["ORD-5821", "SPXID028451101", "SCANNED"],
    ["ORD-5822", "SPXID028451102", "SCANNED"],
    ["ORD-5823", "SPXID028451103", "EXPECTED"],
    ["ORD-5824", "SPXID028451104", "EXPECTED"],
    ["ORD-5825", "SPXID028451105", "EXPECTED"],
    ["ORD-5826", "SPXID028451106", "EXPECTED"],
  ].map(([order, tracking, status]) => ({ order, tracking, status, scannedAt: status === "SCANNED" ? nowISO() : null }));
  const secondPackages = [
    ["ORD-5790", "JNE0008114201", "HANDED_OVER"],
    ["ORD-5791", "JNE0008114202", "HANDED_OVER"],
    ["ORD-5792", "JNE0008114203", "EXPECTED"],
  ].map(([order, tracking, status]) => ({ order, tracking, status, scannedAt: null }));
  return {
    manifests: [
      { id: firstId, shop: "D'Fixer Store", courier: "J&T Express", location: "Gudang Jakarta Selatan", date: today, status: "HANDOVER_IN_PROGRESS", createdAt: nowISO(), createdBy: ACTOR, packages: firstPackages, scans: ["SPXID028451101", "SPXID028451102"].map((tracking) => ({ tracking, result: "MATCH", createdAt: nowISO(), actor: ACTOR })), sessions: [] },
      { id: secondId, shop: "D'Fixer Store", courier: "JNE", location: "Gudang Jakarta Selatan", date: yesterday, status: "PARTIALLY_HANDED_OVER", createdAt: new Date(Date.now() - 86400000).toISOString(), createdBy: ACTOR, packages: secondPackages, scans: [], sessions: [{ id: `TR-${yesterday.replaceAll("-", "")}-01`, receiver: "Budi Santoso", actor: ACTOR, createdAt: new Date(Date.now() - 86400000 + 3600000).toISOString(), note: "Pengambilan tahap pertama", items: ["JNE0008114201", "JNE0008114202"], evidence: null }] },
    ],
    incidents: [{ id: "INC-2601", category: "Paket di luar manifest", manifestId: firstId, tracking: "SPXID028451199", description: "Resi terbaca saat proses sortir, belum ditambahkan ke manifest.", reportedBy: ACTOR, createdAt: nowISO(), status: "OPEN", resolution: "" }],
    audit: [
      { id: makeId("AU"), actor: ACTOR, action: "Manifest dibuka untuk pemindaian", object: firstId, createdAt: nowISO() },
      { id: makeId("AU"), actor: ACTOR, action: "Serah terima tahap pertama dikonfirmasi", object: secondId, createdAt: new Date(Date.now() - 86400000 + 3600000).toISOString() },
      { id: makeId("AU"), actor: ACTOR, action: "Insiden dicatat: Paket di luar manifest", object: "INC-2601", createdAt: nowISO() },
    ],
    importJobs: [],
  };
}

function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return { manifests: [], incidents: [], audit: [], importJobs: [], ...parsed };
    }
  } catch (error) {
    console.warn("Data lokal tidak dapat dibaca.", error);
  }
  const initial = sampleState();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
  return initial;
}

async function hydrateStateFromServer() {
  try {
    const response = await fetch('/api/state');
    if (!response.ok) return;
    const remote = await response.json();
    if (remote && Array.isArray(remote.manifests)) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(remote));
      Object.assign(state, remote);
    }
  } catch (error) {
    console.warn('Sinkronisasi server gagal, memakai data lokal.', error);
  }
}

const state = loadState();
let currentUser = null;
let currentView = "dashboard";
let selectedManifestId = null;
let importDraft = null;
let lastImportJob = null;
let cameraStream = null;
let cameraFrameId = null;
let lastCameraValue = "";
const content = document.querySelector("#page-content");
const modalBackdrop = document.querySelector("#modal-backdrop");
const modal = document.querySelector("#modal");

async function getSession() {
  try {
    const response = await fetch('/api/session', { credentials: 'same-origin' });
    if (!response.ok) return null;
    const data = await response.json();
    currentUser = data.user;
    if (currentUser) localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(currentUser));
    else localStorage.removeItem(CURRENT_USER_KEY);
    return currentUser;
  } catch (error) {
    console.warn('Gagal membaca sesi login.', error);
    return null;
  }
}

async function login(username, password) {
  const response = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    credentials: 'same-origin',
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Login gagal.');
  }

  currentUser = data.user;
  localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(currentUser));
  await hydrateStateFromServer();
  currentView = 'dashboard';
  selectedManifestId = null;
  renderPage();
  return currentUser;
}

async function logout() {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  currentUser = null;
  localStorage.removeItem(CURRENT_USER_KEY);
  currentView = 'dashboard';
  selectedManifestId = null;
  renderPage();
}

function getAllowedViews() {
  return ROLE_PERMISSIONS[currentUser?.role] || ['dashboard'];
}

function hasAccess(view) {
  return getAllowedViews().includes(view);
}

function ensureAccess(view) {
  if (!hasAccess(view)) {
    currentView = 'dashboard';
    selectedManifestId = null;
    toast('Anda tidak memiliki izin untuk membuka halaman ini.', true);
    return false;
  }
  return true;
}

async function persist() {
  const snapshot = JSON.stringify(state);
  localStorage.setItem(STORAGE_KEY, snapshot);
  try {
    await fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: snapshot,
    });
  } catch (error) {
    console.warn('Gagal menyimpan state ke backend.', error);
  }
}

function logAudit(action, object) {
  state.audit.unshift({ id: makeId("AU"), actor: ACTOR, action, object, createdAt: nowISO() });
  state.audit = state.audit.slice(0, 5000);
}

function renderIcons(root = document) {
  if (window.lucide?.createIcons) window.lucide.createIcons({ root });
}

function toast(message, isError = false) {
  const node = document.createElement("div");
  node.className = `toast${isError ? " error" : ""}`;
  node.innerHTML = `<i data-lucide="${isError ? "circle-alert" : "circle-check"}"></i><span>${escapeHtml(message)}</span>`;
  document.querySelector("#toast-region").append(node);
  renderIcons(node);
  window.setTimeout(() => node.remove(), 3800);
}

function openModal(title, subtitle, body) {
  modal.innerHTML = `<div class="modal-heading"><div><h2 id="modal-title">${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div><button type="button" class="modal-close" data-action="close-modal" aria-label="Tutup"><i data-lucide="x"></i></button></div>${body}`;
  modalBackdrop.hidden = false;
  renderIcons(modal);
  modal.querySelector("input,select,textarea,button")?.focus();
}

function closeModal() {
  modalBackdrop.hidden = true;
  modal.innerHTML = "";
}

function getManifest(id) {
  return state.manifests.find((manifest) => manifest.id === id);
}

function getManifestCounts(manifest) {
  const packages = manifest.packages || [];
  const expected = packages.filter((parcel) => parcel.status !== "CANCELLED").length;
  const scanned = packages.filter((parcel) => ["SCANNED", "HANDED_OVER", "REJECTED"].includes(parcel.status)).length;
  const handed = packages.filter((parcel) => parcel.status === "HANDED_OVER").length;
  const outstanding = packages.filter((parcel) => ["EXPECTED", "SCANNED", "REJECTED", "EXCEPTION"].includes(parcel.status)).length;
  const incidents = state.incidents.filter((incident) => incident.manifestId === manifest.id && incident.status === "OPEN").length;
  return { expected, scanned, handed, outstanding, incidents };
}

function computedManifestStatus(manifest) {
  if (["CLOSED", "CANCELLED"].includes(manifest.status)) return manifest.status;
  const counts = getManifestCounts(manifest);
  if (counts.expected > 0 && counts.outstanding === 0) return "CONFIRMED";
  if (counts.handed > 0) return "PARTIALLY_HANDED_OVER";
  if (counts.scanned > 0) return "HANDOVER_IN_PROGRESS";
  return manifest.status === "DRAFT" ? "DRAFT" : "OPEN";
}

function manifestStatusPill(manifest) {
  const status = computedManifestStatus(manifest);
  return `<span class="status-pill ${statusClass(status)}">${escapeHtml(MANIFEST_LABELS[status] || status)}</span>`;
}

function packageStatusPill(status) {
  return `<span class="status-pill ${statusClass(status)}">${escapeHtml(PACKAGE_LABELS[status] || status)}</span>`;
}

function renderLogin() {
  content.innerHTML = `
    <div class="login-shell">
      <div class="login-panel">
        <div class="login-brand">
          <span class="brand-mark"><i data-lucide="package-check"></i></span>
          <div>
            <strong>D'Fixer</strong>
            <small>ORDERGUARD</small>
          </div>
        </div>
        <h1>Masuk ke sistem</h1>
        <p class="page-subtitle">Gunakan akun demo untuk membuka manifest dan serah terima.</p>
        <form id="login-form" class="login-form">
          <div class="field">
            <label for="login-username">Username</label>
            <input id="login-username" name="username" required value="rani" />
          </div>
          <div class="field">
            <label for="login-password">Password</label>
            <input id="login-password" name="password" type="password" required value="rani123" />
          </div>
          <div class="login-account-list">
            <span>Demo akun:</span>
            <button type="button" class="mini-role" data-role="admin" data-user="admin" data-pass="admin123">admin / admin123</button>
            <button type="button" class="mini-role" data-role="rani" data-user="rani" data-pass="rani123">rani / rani123</button>
            <button type="button" class="mini-role" data-role="handover" data-user="handover" data-pass="handover123">handover / handover123</button>
          </div>
          <button class="button button-primary" type="submit" style="width:100%"><i data-lucide="log-in"></i> Masuk</button>
        </form>
      </div>
    </div>
  `;
  renderIcons(content);
}

function renderPage() {
  if (!currentUser) {
    renderLogin();
    return;
  }

  if (!hasAccess(currentView) && currentView !== 'dashboard') {
    currentView = 'dashboard';
  }

  stopCamera();
  document.querySelectorAll(".nav-link").forEach((button) => {
    const allowed = hasAccess(button.dataset.view);
    button.hidden = !allowed;
    button.classList.toggle("active", button.dataset.view === currentView);
  });
  const roleText = ROLE_LABELS[currentUser.role] || 'User';
  if (document.querySelector('#user-role-label')) {
    document.querySelector('#user-role-label').textContent = roleText;
  }
  document.querySelector("#breadcrumb-current").textContent = selectedManifestId && currentView === "manifest-detail" ? selectedManifestId : VIEW_LABELS[currentView] || "Manifest";
  document.querySelector("#nav-manifest-count").textContent = state.manifests.filter((manifest) => !["CLOSED", "CANCELLED"].includes(computedManifestStatus(manifest))).length;
  document.querySelector("#nav-incident-count").textContent = state.incidents.filter((incident) => incident.status === "OPEN").length;
  const renderers = {
    dashboard: renderDashboard,
    manifests: renderManifests,
    imports: renderImports,
    incidents: renderIncidents,
    reports: renderReports,
    audit: renderAudit,
    "manifest-detail": () => renderManifestDetail(getManifest(selectedManifestId)),
  };
  (renderers[currentView] || renderDashboard)();
  renderIcons(content);
  document.querySelector("#sidebar").classList.remove("open");
}

function pageHeading(eyebrow, title, subtitle, actions = "") {
  return `<div class="page-heading"><div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1><p class="page-subtitle">${escapeHtml(subtitle)}</p></div><div class="heading-actions">${actions}</div></div>`;
}

function emptyState(icon, title, text) {
  return `<div class="empty-state"><span><i data-lucide="${icon}"></i></span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></div>`;
}

function manifestRow(manifest) {
  const counts = getManifestCounts(manifest);
  return `<tr>
    <td><button class="manifest-link" data-action="open-manifest" data-id="${escapeHtml(manifest.id)}">${escapeHtml(manifest.id)}</button><span class="cell-secondary">${escapeHtml(manifest.shop)}</span></td>
    <td>${escapeHtml(manifest.courier)}</td>
    <td>${formatDate(manifest.date)}</td>
    <td><span class="cell-primary">${counts.expected} paket</span><span class="cell-secondary">${counts.handed} diterima</span></td>
    <td>${manifestStatusPill(manifest)}</td>
    <td><button class="table-action" data-action="open-manifest" data-id="${escapeHtml(manifest.id)}"><i data-lucide="arrow-up-right"></i> Buka</button></td>
  </tr>`;
}

function renderDashboard() {
  const manifests = [...state.manifests].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const totals = state.manifests.reduce((summary, manifest) => {
    const count = getManifestCounts(manifest);
    summary.planned += count.expected;
    summary.scanned += count.scanned;
    summary.handed += count.handed;
    summary.remaining += count.outstanding;
    return summary;
  }, { planned: 0, scanned: 0, handed: 0, remaining: 0 });
  const active = state.manifests.filter((manifest) => !["CLOSED", "CANCELLED", "CONFIRMED"].includes(computedManifestStatus(manifest))).length;
  const issues = state.incidents.filter((incident) => incident.status === "OPEN").length;
  const recentRows = manifests.slice(0, 5).map(manifestRow).join("");
  const scannedPercent = totals.planned ? Math.round((totals.scanned / totals.planned) * 100) : 0;
  const handedPercent = totals.planned ? Math.round((totals.handed / totals.planned) * 100) : 0;
  content.innerHTML = `${pageHeading("PUSAT OPERASIONAL", "Ringkasan serah terima", "Pantau paket yang direncanakan, dipindai, dan diterima kurir.", '<button class="button button-secondary" data-action="go-import"><i data-lucide="file-up"></i> Impor data</button><button class="button button-primary" data-action="new-manifest"><i data-lucide="plus"></i> Manifest baru</button>')}
    <div class="stats-grid">
      <article class="stat-card"><div class="stat-top"><span>Paket direncanakan</span><span class="stat-icon"><i data-lucide="package"></i></span></div><div class="stat-value">${totals.planned}<span class="stat-context">semua manifest</span></div></article>
      <article class="stat-card"><div class="stat-top"><span>Paket dipindai unik</span><span class="stat-icon blue"><i data-lucide="scan-line"></i></span></div><div class="stat-value">${totals.scanned}<span class="stat-context">${scannedPercent}% dari rencana</span></div></article>
      <article class="stat-card"><div class="stat-top"><span>Diterima kurir</span><span class="stat-icon"><i data-lucide="badge-check"></i></span></div><div class="stat-value">${totals.handed}<span class="stat-context">terkonfirmasi</span></div></article>
      <article class="stat-card"><div class="stat-top"><span>Perlu ditindaklanjuti</span><span class="stat-icon ${issues ? "coral" : "amber"}"><i data-lucide="triangle-alert"></i></span></div><div class="stat-value">${issues}<span class="stat-context">${active} manifest aktif</span></div></article>
    </div>
    <div class="dashboard-grid">
      <section class="panel"><div class="panel-heading"><div><h2>Manifest terbaru</h2><p>Aktivitas operasional lintas jadwal</p></div><button class="text-button" data-action="go-manifests">Semua manifest <i data-lucide="arrow-right"></i></button></div>
        ${manifests.length ? `<div class="table-wrap"><table class="manifest-table"><thead><tr><th>MANIFEST / TOKO</th><th>KURIR</th><th>JADWAL</th><th>REKONSILIASI</th><th>STATUS</th><th></th></tr></thead><tbody>${recentRows}</tbody></table></div>` : emptyState("boxes", "Belum ada manifest", "Impor data atau buat manifest baru untuk mulai mencatat serah terima.")}
      </section>
      <section class="panel"><div class="panel-heading"><div><h2>Rekonsiliasi paket</h2><p>Akumulasi dari semua manifest</p></div><span class="status-pill ${totals.remaining ? "partial" : "confirmed"}">${totals.remaining} belum selesai</span></div>
        <div class="recon-list"><div class="recon-row"><div class="recon-label"><span>Dipindai unik</span><strong>${totals.scanned} / ${totals.planned}</strong></div><div class="recon-track"><div class="recon-fill" style="width:${Math.min(scannedPercent, 100)}%"></div></div></div>
        <div class="recon-row"><div class="recon-label"><span>Diterima kurir</span><strong>${totals.handed} / ${totals.planned}</strong></div><div class="recon-track"><div class="recon-fill ${handedPercent < 100 ? "warn" : ""}" style="width:${Math.min(handedPercent, 100)}%"></div></div></div>
        <div class="recon-row"><div class="recon-label"><span>Paket belum diserahkan</span><strong>${totals.remaining}</strong></div><div class="recon-track"><div class="recon-fill warn" style="width:${totals.planned ? Math.min(Math.round((totals.remaining / totals.planned) * 100), 100) : 0}%"></div></div></div></div>
        <div class="activity-strip"><i data-lucide="shield-check"></i><p>Jumlah diterima dihitung dari daftar resi di sesi serah terima terkonfirmasi, bukan dari angka yang diketik.</p></div>
      </section>
    </div>
    <div class="footer-note">Data demo tersimpan hanya di browser ini. Jangan gunakan untuk transaksi operasional nyata sebelum backend, autentikasi, dan kontrol akses tenant diterapkan.</div>`;
}

function renderManifests() {
  const manifests = [...state.manifests].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const actions = '<button class="button button-secondary" data-action="go-import"><i data-lucide="file-up"></i> Impor data</button><button class="button button-primary" data-action="new-manifest"><i data-lucide="plus"></i> Buat manifest</button>';
  content.innerHTML = `${pageHeading("OPERASIONAL", "Semua manifest", "Daftar paket rencana dan status serah terima per kurir.", actions)}
    <section class="panel"><div class="section-toolbar"><div class="toolbar-left"><label class="search-box"><i data-lucide="search"></i><input id="manifest-search" type="search" placeholder="Cari ID, toko, atau resi" aria-label="Cari manifest" /></label><select id="manifest-status-filter" class="filter-select" aria-label="Filter status"><option value="">Semua status</option><option value="active">Aktif</option><option value="PARTIALLY_HANDED_OVER">Diterima sebagian</option><option value="CONFIRMED">Terkonfirmasi</option><option value="CLOSED">Ditutup</option><option value="CANCELLED">Dibatalkan</option></select></div><div class="toolbar-right"><span class="cell-secondary">${manifests.length} manifest</span></div></div>
      ${manifests.length ? `<div class="table-wrap"><table class="manifest-table"><thead><tr><th>MANIFEST / TOKO</th><th>KURIR</th><th>JADWAL</th><th>REKONSILIASI</th><th>STATUS</th><th>AKSI</th></tr></thead><tbody id="manifest-table-body">${manifests.map(manifestRow).join("")}</tbody></table></div>` : emptyState("boxes", "Manifest belum dibuat", "Impor CSV atau buat manifest secara manual untuk mulai.")}
    </section><div class="footer-note">Satu resi hanya dapat berada pada satu manifest aktif. Pemindahan paket antarmanifest memerlukan proses koreksi tercatat.</div>`;
}

function filterManifestRows() {
  const body = document.querySelector("#manifest-table-body");
  if (!body) return;
  const query = normalize(document.querySelector("#manifest-search")?.value || "");
  const filter = document.querySelector("#manifest-status-filter")?.value || "";
  const manifests = [...state.manifests].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).filter((manifest) => {
    const haystack = normalize([manifest.id, manifest.shop, manifest.courier, ...manifest.packages.map((parcel) => parcel.tracking)].join(" "));
    const status = computedManifestStatus(manifest);
    const matchesStatus = !filter || (filter === "active" ? !["CLOSED", "CANCELLED", "CONFIRMED"].includes(status) : status === filter);
    return haystack.includes(query) && matchesStatus;
  });
  body.innerHTML = manifests.map(manifestRow).join("") || `<tr><td colspan="6">${escapeHtml("Tidak ada manifest yang cocok dengan filter.")}</td></tr>`;
  renderIcons(body);
}

function importField(key, label, required, selected) {
  const options = importDraft.headers.map((header, index) => `<option value="${index}" ${String(index) === String(selected) ? "selected" : ""}>${escapeHtml(header || `Kolom ${index + 1}`)}</option>`).join("");
  return `<div class="field"><label for="map-${key}">${escapeHtml(label)} ${required ? '<span class="required-mark">*</span>' : ""}</label><select id="map-${key}" data-map="${key}"><option value="">Tidak dipetakan</option>${options}</select></div>`;
}

function defaultMapping(headers) {
  const aliases = {
    order: ["nomor pesanan", "no pesanan", "order id", "order number", "order no", "pesanan", "nomor order"],
    tracking: ["nomor resi", "resi", "no resi", "tracking number", "tracking no", "awb", "waybill", "no. resi"],
    courier: ["kurir", "ekspedisi", "shipping provider", "courier", "logistic"],
    date: ["tanggal rencana serah terima", "tanggal", "jadwal", "handover date", "ship date"],
    shop: ["toko", "store", "nama toko"],
    quantity: ["jumlah paket", "jumlah", "qty", "quantity", "packages"],
  };
  return Object.fromEntries(Object.entries(aliases).map(([key, names]) => [key, headers.findIndex((header) => names.includes(normalize(header).replace(/[._]/g, " ")))]));
}

function normalizeImportDate(value) {
  const input = String(value || "").trim();
  if (!input) return todayISO();
  let parts = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!parts) {
    const localized = input.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
    if (localized) {
      const year = localized[3].length === 2 ? `20${localized[3]}` : localized[3];
      parts = [localized[0], year, localized[2], localized[1]];
    }
  }
  if (!parts) return null;
  const [, year, month, day] = parts;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) || date.getUTCDate() !== Number(day)) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function renderImports() {
  const previousJob = lastImportJob ? `<div class="callout" style="margin-bottom:14px"><i data-lucide="circle-check"></i><p><strong>Impor selesai.</strong> ${lastImportJob.valid} baris valid masuk ke ${lastImportJob.manifestCount} manifest; ${lastImportJob.failed} baris ditolak dan tercatat.${lastImportJob.failed ? ` <button class="text-button" data-action="export-failed" data-id="${escapeHtml(lastImportJob.id)}">Unduh baris gagal</button>` : ""}</p></div>` : "";
  content.innerHTML = `${pageHeading("DATA MASUK", "Impor pesanan", "Unggah CSV atau Excel, petakan kolom, lalu tinjau hasil validasi sebelum membuat manifest.")}
    ${previousJob}<div class="import-layout"><section class="panel import-main"><div class="step-line"><span class="step-number">1</span><div><strong>Pilih file dan petakan kolom</strong><small>Data diproses di browser ini; pelanggan tidak perlu ikut diimpor.</small></div></div>
      <label class="upload-zone" id="upload-zone" for="import-file"><span class="upload-icon"><i data-lucide="file-up"></i></span><strong>Letakkan file di sini atau pilih dari perangkat</strong><p>CSV, XLS, atau XLSX · satu baris untuk satu resi/paket</p><button class="button button-secondary button-small" type="button" id="choose-file">Pilih file</button><input id="import-file" type="file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" /><span class="file-name" id="file-name">Belum ada file dipilih</span></label>
      <div id="import-mapping">${importDraft ? renderMapping() : ""}</div><div id="import-preview"></div>
    </section><aside class="import-sidebar"><div class="guide-card"><h3>Validasi sebelum manifest</h3><ul><li><i data-lucide="check"></i>Nomor pesanan, resi, dan kurir harus terisi.</li><li><i data-lucide="check"></i>Resi duplikat di file atau manifest aktif ditolak, tidak dihapus diam-diam.</li><li><i data-lucide="check"></i>Kolom toko dan jadwal dapat dipetakan untuk pengelompokan.</li><li><i data-lucide="check"></i>Hanya baris valid yang masuk ke manifest.</li></ul></div><div class="guide-note"><strong>Privasi data</strong><p>File tidak dikirim ke server. Data yang disimpan dalam demo ini tetap berada di penyimpanan browser pada perangkat yang digunakan.</p></div><div class="guide-card"><h3>Riwayat impor terakhir</h3>${state.importJobs.length ? state.importJobs.slice(0, 5).map((job) => `<div class="history-session"><div><strong>${escapeHtml(job.fileName)}</strong><small>${formatDateTime(job.createdAt)} · ${job.valid} valid · ${job.failed} ditolak</small></div></div>`).join("") : '<p class="page-subtitle">Belum ada riwayat impor.</p>'}</div></aside></div>`;
  if (importDraft) {
    document.querySelector("#file-name").textContent = importDraft.fileName;
    renderImportPreview();
  }
}

function renderMapping() {
  const mapping = importDraft.mapping || defaultMapping(importDraft.headers);
  return `<div class="mapping-grid">${importField("order", "Nomor pesanan", true, mapping.order)}${importField("tracking", "Nomor resi", true, mapping.tracking)}${importField("courier", "Kurir / ekspedisi", true, mapping.courier)}${importField("shop", "Toko", false, mapping.shop)}${importField("date", "Tanggal rencana", false, mapping.date)}${importField("quantity", "Jumlah paket", false, mapping.quantity)}</div><div class="field-help">Jika kolom toko tidak dipetakan, baris akan masuk ke toko "D'Fixer Store". Nilai jumlah paket harus 1 agar satu resi mewakili satu paket.</div>`;
}

function readImportMapping() {
  if (!importDraft) return;
  importDraft.mapping = Object.fromEntries(["order", "tracking", "courier", "shop", "date", "quantity"].map((key) => [key, document.querySelector(`#map-${key}`)?.value ?? ""]));
}

function analyzeImport() {
  if (!importDraft) return [];
  const mapping = importDraft.mapping || {};
  const validMapping = ["order", "tracking", "courier"].every((key) => mapping[key] !== "" && mapping[key] !== undefined);
  if (!validMapping) return importDraft.rows.map((cells, index) => ({ line: index + 2, order: "", tracking: "", courier: "", shop: "", date: "", issue: "Petakan nomor pesanan, nomor resi, dan kurir terlebih dahulu." }));
  const seen = new Set();
  const existingTracking = new Map();
  state.manifests.forEach((manifest) => manifest.packages.forEach((parcel) => existingTracking.set(trackingScope(parcel.tracking, manifest.shop, manifest.courier, manifest.date), manifest.id)));
  return importDraft.rows.map((cells, index) => {
    const get = (key) => mapping[key] === "" || mapping[key] === undefined ? "" : String(cells[Number(mapping[key])] ?? "").trim();
    const dateInput = get("date");
    const item = { line: index + 2, order: get("order"), tracking: get("tracking"), courier: get("courier"), shop: get("shop") || "D'Fixer Store", date: dateInput ? normalizeImportDate(dateInput) : todayISO(), quantity: get("quantity") };
    const trackingKey = normalize(item.tracking);
    const scopedTracking = trackingScope(item.tracking, item.shop, item.courier, item.date);
    if (!item.order) item.issue = "Nomor pesanan kosong.";
    else if (!item.tracking) item.issue = "Nomor resi kosong.";
    else if (!item.courier) item.issue = "Kurir/ekspedisi kosong.";
    else if (item.quantity && Number(item.quantity) !== 1) item.issue = "Jumlah paket harus 1 per resi.";
    else if (!item.date) item.issue = "Tanggal rencana tidak valid. Gunakan YYYY-MM-DD atau DD/MM/YYYY.";
    else if (seen.has(trackingKey)) item.issue = "Nomor resi duplikat dalam file.";
    else if (existingTracking.has(scopedTracking)) item.issue = `Resi sudah ada di manifest ${existingTracking.get(scopedTracking)}.`;
    if (trackingKey) seen.add(trackingKey);
    return item;
  });
}

function renderImportPreview() {
  const target = document.querySelector("#import-preview");
  if (!target || !importDraft) return;
  readImportMapping();
  const rows = analyzeImport();
  const valid = rows.filter((row) => !row.issue);
  const failed = rows.filter((row) => row.issue);
  target.innerHTML = `<div class="preview-summary"><div class="preview-metric"><span>Baris diperiksa</span><strong>${rows.length}</strong></div><div class="preview-metric"><span>Siap dimanifestkan</span><strong>${valid.length}</strong></div><div class="preview-metric invalid"><span>Perlu diperbaiki</span><strong>${failed.length}</strong></div></div>
    <div class="preview-table"><table><thead><tr><th>BARIS</th><th>NOMOR PESANAN</th><th>NOMOR RESI</th><th>KURIR</th><th>HASIL</th></tr></thead><tbody>${rows.slice(0, 100).map((row) => `<tr><td>${row.line}</td><td>${escapeHtml(row.order || "-")}</td><td class="mono">${escapeHtml(row.tracking || "-")}</td><td>${escapeHtml(row.courier || "-")}</td><td class="${row.issue ? "row-error" : ""}">${escapeHtml(row.issue || "Valid")}</td></tr>`).join("")}</tbody></table></div>
    ${rows.length > 100 ? `<p class="field-help">Menampilkan 100 dari ${rows.length} baris. Validasi mencakup seluruh data.</p>` : ""}
    <div class="modal-actions" style="margin-top:13px"><button class="button button-primary" data-action="commit-import" ${valid.length ? "" : "disabled"}><i data-lucide="boxes"></i> Buat manifest (${valid.length} baris valid)</button></div>`;
  renderIcons(target);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { row.push(field); field = ""; }
    else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((cell) => String(cell).trim())) rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  row.push(field);
  if (row.some((cell) => String(cell).trim())) rows.push(row);
  if (quoted) throw new Error("Tanda kutip pada CSV tidak berpasangan.");
  return rows;
}

function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (window.xlsxLoadPromise) return window.xlsxLoadPromise;
  window.xlsxLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    script.onload = () => window.XLSX ? resolve(window.XLSX) : reject(new Error("Pustaka Excel tidak dapat dimuat."));
    script.onerror = () => reject(new Error("Koneksi dibutuhkan untuk memuat pembaca Excel. Coba CSV atau periksa koneksi internet."));
    document.head.append(script);
  });
  return window.xlsxLoadPromise;
}

async function readImportFile(file) {
  const extension = file.name.split(".").pop().toLocaleLowerCase();
  let matrix;
  if (extension === "csv") matrix = parseCsv(await file.text());
  else if (["xlsx", "xls"].includes(extension)) {
    const XLSX = await loadXlsx();
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
    matrix = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: "", raw: false });
  } else throw new Error("Format file belum didukung.");
  if (!matrix || matrix.length < 2) throw new Error("File harus memiliki baris judul dan minimal satu baris data.");
  const headers = matrix[0].map((header) => String(header).trim());
  const rows = matrix.slice(1).filter((cells) => cells.some((cell) => String(cell ?? "").trim()));
  if (!rows.length) throw new Error("Tidak ada baris data pada file.");
  importDraft = { fileName: file.name, headers, rows, mapping: defaultMapping(headers) };
  renderImports();
}

function nextManifestId(date) {
  const prefix = `OG-${date.replaceAll("-", "").slice(2)}-`;
  const highest = state.manifests.reduce((max, manifest) => {
    if (!manifest.id.startsWith(prefix)) return max;
    const suffix = Number(manifest.id.slice(prefix.length));
    return Number.isFinite(suffix) ? Math.max(max, suffix) : max;
  }, 0);
  return `${prefix}${String(highest + 1).padStart(3, "0")}`;
}

function createManifest({ shop, courier, date, location, parcels, source = "manual" }) {
  const manifest = { id: nextManifestId(date), shop, courier, date, location: location || "Lokasi belum ditentukan", status: "OPEN", createdAt: nowISO(), createdBy: ACTOR, source, packages: parcels.map((parcel) => ({ ...parcel, status: "EXPECTED", scannedAt: null })), scans: [], sessions: [] };
  state.manifests.unshift(manifest);
  return manifest;
}

function commitImport() {
  if (!importDraft) return;
  readImportMapping();
  const rows = analyzeImport();
  const validRows = rows.filter((row) => !row.issue);
  const failedRows = rows.filter((row) => row.issue);
  if (!validRows.length) return toast("Tidak ada baris valid untuk dimanifestkan.", true);
  const groups = new Map();
  validRows.forEach((row) => {
    const date = row.date;
    const key = [normalize(row.shop), normalize(row.courier), date].join("|");
    if (!groups.has(key)) groups.set(key, { shop: row.shop, courier: row.courier, date, parcels: [] });
    groups.get(key).parcels.push({ order: row.order, tracking: row.tracking });
  });
  const created = [...groups.values()].map((group) => createManifest({ ...group, location: "Lokasi belum ditentukan", source: importDraft.fileName }));
  const job = { id: makeId("IMP"), fileName: importDraft.fileName, total: rows.length, valid: validRows.length, failed: failedRows.length, manifestCount: created.length, createdAt: nowISO(), errors: failedRows.map(({ line, order, tracking, issue }) => ({ line, order, tracking, issue })) };
  state.importJobs.unshift(job);
  logAudit(`Impor ${job.fileName}: ${job.valid} valid, ${job.failed} ditolak`, job.id);
  persist();
  lastImportJob = job;
  importDraft = null;
  toast(`${job.valid} paket dimasukkan ke ${created.length} manifest.`);
  renderImports();
}

function renderManifestDetail(manifest) {
  if (!manifest) {
    currentView = "manifests";
    renderPage();
    return;
  }
  const counts = getManifestCounts(manifest);
  const scannedPackages = manifest.packages.filter((parcel) => parcel.status === "SCANNED");
  const scanEntries = [...(manifest.scans || [])].reverse().slice(0, 12);
  const canScan = !["CLOSED", "CANCELLED", "CONFIRMED"].includes(computedManifestStatus(manifest));
  const canHandover = scannedPackages.length > 0 && canScan;
  const sessionList = [...(manifest.sessions || [])].reverse().map((session) => `<div class="history-session"><div><strong>${escapeHtml(session.id)} · ${session.items.length} paket diterima</strong><small>${formatDateTime(session.createdAt)} · Penerima: ${escapeHtml(session.receiver)}</small>${session.note ? `<small>${escapeHtml(session.note)}</small>` : ""}</div>${session.evidence ? `<button class="table-action" data-action="view-evidence" data-id="${escapeHtml(session.id)}"><i data-lucide="image"></i> Bukti foto</button>` : '<span class="cell-secondary">Tanpa foto</span>'}</div>`).join("");
  content.innerHTML = `<div class="detail-header"><div class="detail-title"><button class="back-button" data-action="back-manifests" aria-label="Kembali"><i data-lucide="arrow-left"></i></button><div><h1>${escapeHtml(manifest.id)}</h1><p class="page-subtitle">${escapeHtml(manifest.shop)} · ${escapeHtml(manifest.courier)} · ${formatDate(manifest.date)}</p></div></div><div class="heading-actions">${manifestStatusPill(manifest)}${computedManifestStatus(manifest) === "CONFIRMED" ? `<button class="button button-secondary" data-action="close-manifest" data-id="${escapeHtml(manifest.id)}"><i data-lucide="archive"></i> Tutup manifest</button>` : ""}${!["CLOSED", "CANCELLED", "CONFIRMED"].includes(computedManifestStatus(manifest)) ? `<button class="button button-secondary" data-action="cancel-manifest" data-id="${escapeHtml(manifest.id)}"><i data-lucide="ban"></i> Batalkan</button>` : ""}</div></div>
    <div class="detail-overview"><div class="detail-mini"><span>Direncanakan</span><strong>${counts.expected}</strong></div><div class="detail-mini"><span>Dipindai unik</span><strong>${counts.scanned}</strong></div><div class="detail-mini"><span>Diterima kurir</span><strong>${counts.handed}</strong></div><div class="detail-mini"><span>Belum terselesaikan</span><strong>${counts.outstanding}</strong></div></div>
    <div class="detail-grid"><section class="panel scanner-panel"><div class="scanner-title"><div><h2>Pindai paket</h2><p>Pindai kode dengan scanner keyboard atau masukkan nomor resi manual.</p></div><span class="status-pill open">${manifest.packages.filter((parcel) => parcel.status === "EXPECTED").length} menunggu</span></div>
      <form class="scan-entry" id="scan-form"><input id="scan-input" autocomplete="off" placeholder="Contoh: SPXID028451101" aria-label="Nomor resi untuk dipindai" ${canScan ? "" : "disabled"} /><button class="button button-primary" type="submit" ${canScan ? "" : "disabled"}><i data-lucide="scan-line"></i> Pindai</button></form>
      <div class="scan-feedback" id="scan-feedback"><i data-lucide="scan"></i><span>Arahkan fokus ke kolom lalu pindai barcode.</span></div>
      <div class="scanner-actions"><button class="button button-secondary button-small" id="camera-toggle" type="button"><i data-lucide="camera"></i> Buka kamera</button></div><video class="camera-frame" id="camera-frame" playsinline muted></video>
      <div class="scan-log" id="scan-log">${scanEntries.map((entry) => `<div class="scan-log-entry"><div><strong>${escapeHtml(entry.tracking)}</strong><small style="display:block;margin-top:4px">${formatDateTime(entry.createdAt)} · ${escapeHtml(entry.actor || ACTOR)}</small></div><span class="status-pill ${statusClass(entry.result)}">${escapeHtml(SCAN_LABELS[entry.result] || entry.result)}</span></div>`).join("") || '<span class="field-help">Belum ada aktivitas pemindaian.</span>'}</div>
    </section><section class="panel handover-panel"><h2>Konfirmasi serah terima</h2><p>Setiap sesi menyimpan daftar resi yang dipilih, penerima, waktu, dan bukti secara terpisah.</p>
      <form id="handover-form"><div class="handover-fields"><div class="field"><label for="receiver-name">Nama penerima / kurir <span class="required-mark">*</span></label><input id="receiver-name" name="receiver" required placeholder="Nama petugas kurir" /></div><div class="field"><label for="handover-note">Catatan sesi</label><input id="handover-note" name="note" placeholder="Opsional" /></div><div class="field"><label for="handover-photo">Foto bukti</label><input id="handover-photo" name="photo" type="file" accept="image/*" /><span class="field-help">Opsional. Foto disimpan di browser ini.</span></div></div>
        ${scannedPackages.length ? `<div class="field" style="margin-top:12px"><label>Paket yang diterima (${scannedPackages.length} dipindai)</label>${scannedPackages.map((parcel) => `<label class="handover-ready"><span><input type="checkbox" name="accepted" value="${escapeHtml(parcel.tracking)}" checked /> <span class="mono">${escapeHtml(parcel.tracking)}</span></span><span>Diterima</span></label>`).join("")}<span class="field-help">Hapus centang pada paket yang ditolak kurir. Paket tersebut tidak diberi status diterima.</span></div>` : `<div class="handover-ready"><span>Belum ada paket yang siap diserahkan</span><strong>0 paket</strong></div>`}
        <button class="button button-primary" type="submit" style="width:100%;margin-top:12px" ${canHandover ? "" : "disabled"}><i data-lucide="badge-check"></i> Konfirmasi penerimaan</button>
      </form></section></div>
    <section class="panel history-panel"><div class="panel-heading"><div><h2>Daftar paket manifest</h2><p>Paket aktual tetap terikat pada sesi penerimaannya.</p></div><span class="status-pill ${counts.outstanding ? "partial" : "confirmed"}">${counts.outstanding} belum selesai</span></div><div class="table-wrap"><table><thead><tr><th>NOMOR PESANAN</th><th>NOMOR RESI</th><th>STATUS PAKET</th><th>WAKTU PINDAI</th></tr></thead><tbody>${manifest.packages.map((parcel) => `<tr><td>${escapeHtml(parcel.order)}</td><td class="mono">${escapeHtml(parcel.tracking)}</td><td>${packageStatusPill(parcel.status)}</td><td>${formatDateTime(parcel.scannedAt)}</td></tr>`).join("")}</tbody></table></div></section>
    <section class="panel history-panel"><div class="panel-heading"><div><h2>Riwayat serah terima</h2><p>Sesi terkonfirmasi tidak dapat ditimpa oleh sesi berikutnya.</p></div><span class="status-pill">${manifest.sessions.length} sesi</span></div>${sessionList || emptyState("handshake", "Belum ada sesi serah terima", "Pindai paket lalu konfirmasikan paket yang diterima kurir.")}</section>
    <div class="footer-note">Lokasi: ${escapeHtml(manifest.location)} · Dibuat ${formatDateTime(manifest.createdAt)} oleh ${escapeHtml(manifest.createdBy || ACTOR)}.</div>`;
  const scanInput = document.querySelector("#scan-input");
  if (scanInput && canHandover) scanInput.focus();
}

function recordScan(manifest, rawTracking) {
  const tracking = String(rawTracking || "").trim();
  if (!tracking) return;
  if (["CLOSED", "CANCELLED", "CONFIRMED"].includes(computedManifestStatus(manifest))) return toast("Manifest sudah final dan tidak menerima pemindaian baru.", true);
  const parcel = manifest.packages.find((item) => normalize(item.tracking) === normalize(tracking));
  let result = "INVALID_PACKAGE";
  if (parcel) {
    if (parcel.status === "HANDED_OVER") result = "ALREADY_HANDED_OVER";
    else if (parcel.status === "SCANNED") result = "DUPLICATE_SCAN";
    else if (parcel.status === "CANCELLED") result = "CANCELLED";
    else if (parcel.status === "REJECTED") result = "INVALID_PACKAGE";
    else if (parcel.status === "EXPECTED") {
      parcel.status = "SCANNED";
      parcel.scannedAt = nowISO();
      result = "MATCH";
    }
  } else {
    const handedElsewhere = state.manifests.some((other) => other.id !== manifest.id && other.packages.some((item) => normalize(item.tracking) === normalize(tracking) && item.status === "HANDED_OVER"));
    result = handedElsewhere ? "ALREADY_HANDED_OVER" : "NOT_IN_MANIFEST";
  }
  manifest.scans.push({ tracking, result, createdAt: nowISO(), actor: ACTOR });
  if (result === "NOT_IN_MANIFEST") logAudit(`Pemindaian di luar manifest: ${tracking}`, manifest.id);
  else if (result === "MATCH") logAudit(`Paket dipindai: ${tracking}`, manifest.id);
  persist();
  currentView = "manifest-detail";
  renderPage();
  const feedback = document.querySelector("#scan-feedback");
  const stateClass = result === "MATCH" ? "match" : ["DUPLICATE_SCAN"].includes(result) ? "warning" : "error";
  feedback.className = `scan-feedback ${stateClass}`;
  feedback.innerHTML = `<i data-lucide="${result === "MATCH" ? "circle-check" : result === "DUPLICATE_SCAN" ? "triangle-alert" : "circle-alert"}"></i><span><strong>${escapeHtml(SCAN_LABELS[result])}:</strong> ${escapeHtml(tracking)}${result === "NOT_IN_MANIFEST" ? ". Resi ini tidak menambah jumlah paket yang sah." : ""}</span>`;
  renderIcons(feedback);
  document.querySelector("#scan-input")?.focus();
}

function loadImageData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Foto tidak dapat dibaca."));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("File tidak dapat diproses sebagai gambar."));
      image.onload = () => {
        const scale = Math.min(1, 1000 / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.65));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function confirmHandover(form) {
  const manifest = getManifest(selectedManifestId);
  const formData = new FormData(form);
  const receiver = String(formData.get("receiver") || "").trim();
  const accepted = formData.getAll("accepted");
  const scanned = manifest.packages.filter((parcel) => parcel.status === "SCANNED");
  if (!receiver || !accepted.length) return toast("Nama penerima dan minimal satu paket yang diterima wajib diisi.", true);
  if (accepted.some((tracking) => !scanned.some((parcel) => parcel.tracking === tracking))) return toast("Daftar paket berubah. Muat ulang manifest sebelum mengonfirmasi.", true);
  const rejected = scanned.filter((parcel) => !accepted.includes(parcel.tracking));
  if (!window.confirm(`Konfirmasi ${accepted.length} paket diterima oleh ${receiver}? Catatan sesi ini tidak dapat ditimpa.`)) return;
  let evidence = null;
  const photo = formData.get("photo");
  if (photo instanceof File && photo.size) {
    try { evidence = await loadImageData(photo); }
    catch (error) { return toast(error.message, true); }
  }
  const session = { id: makeId("TR"), receiver, actor: ACTOR, createdAt: nowISO(), note: String(formData.get("note") || "").trim(), items: [...accepted], evidence };
  accepted.forEach((tracking) => {
    const parcel = manifest.packages.find((item) => item.tracking === tracking);
    parcel.status = "HANDED_OVER";
  });
  rejected.forEach((parcel) => {
    parcel.status = "REJECTED";
    state.incidents.unshift({ id: makeId("INC"), category: "Paket ditolak kurir", manifestId: manifest.id, tracking: parcel.tracking, description: `Paket ditolak oleh ${receiver} saat sesi ${session.id}.`, reportedBy: ACTOR, createdAt: nowISO(), status: "OPEN", resolution: "" });
  });
  manifest.sessions.push(session);
  manifest.status = getManifestCounts(manifest).outstanding === 0 ? "CONFIRMED" : "PARTIALLY_HANDED_OVER";
  logAudit(`Serah terima ${session.id} dikonfirmasi: ${accepted.length} diterima${rejected.length ? `, ${rejected.length} ditolak` : ""}`, manifest.id);
  persist();
  toast(`Serah terima tersimpan untuk ${accepted.length} paket.`);
  renderPage();
}

function stopCamera() {
  if (cameraFrameId) window.cancelAnimationFrame(cameraFrameId);
  cameraFrameId = null;
  if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  const video = document.querySelector("#camera-frame");
  if (video) { video.pause(); video.srcObject = null; video.classList.remove("visible"); }
}

async function toggleCamera() {
  const video = document.querySelector("#camera-frame");
  if (cameraStream) { stopCamera(); return; }
  if (!navigator.mediaDevices?.getUserMedia || !("BarcodeDetector" in window)) return toast("Kamera barcode tidak didukung browser ini. Gunakan scanner keyboard atau input manual.", true);
  try {
    const detector = new BarcodeDetector({ formats: ["qr_code", "code_128", "ean_13", "ean_8", "code_39", "upc_a", "upc_e"] });
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
    video.srcObject = cameraStream;
    video.classList.add("visible");
    await video.play();
    const scanFrame = async () => {
      if (!cameraStream) return;
      try {
        const codes = await detector.detect(video);
        const value = codes[0]?.rawValue?.trim();
        if (value && value !== lastCameraValue) {
          lastCameraValue = value;
          const manifest = getManifest(selectedManifestId);
          if (manifest) recordScan(manifest, value);
          window.setTimeout(() => { lastCameraValue = ""; }, 1300);
        }
      } catch (error) { console.warn("Frame kamera tidak dapat dibaca.", error); }
      if (cameraStream) cameraFrameId = window.requestAnimationFrame(scanFrame);
    };
    cameraFrameId = window.requestAnimationFrame(scanFrame);
  } catch (error) {
    stopCamera();
    toast(`Kamera tidak dapat dibuka: ${error.message}`, true);
  }
}

function renderIncidents() {
  const openCount = state.incidents.filter((incident) => incident.status === "OPEN").length;
  const rows = [...state.incidents].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((incident) => {
    const manifest = getManifest(incident.manifestId);
    return `<tr><td><span class="cell-primary">${escapeHtml(incident.id)}</span><span class="cell-secondary">${formatDateTime(incident.createdAt)}</span></td><td>${escapeHtml(incident.category)}</td><td>${manifest ? `<button class="manifest-link" data-action="open-manifest" data-id="${escapeHtml(manifest.id)}">${escapeHtml(manifest.id)}</button>` : "-"}</td><td class="mono">${escapeHtml(incident.tracking || "-")}</td><td>${escapeHtml(incident.description)}</td><td><span class="status-pill ${statusClass(incident.status)}">${incident.status === "OPEN" ? "Terbuka" : "Selesai"}</span></td><td>${incident.status === "OPEN" ? `<button class="table-action" data-action="resolve-incident" data-id="${escapeHtml(incident.id)}"><i data-lucide="check"></i> Selesaikan</button>` : `<span class="cell-secondary">${escapeHtml(incident.resolution)}</span>`}</td></tr>`;
  }).join("");
  content.innerHTML = `${pageHeading("PENGENDALIAN SELISIH", "Insiden dan pengecualian", "Catat masalah paket, tetapkan tindak lanjut, dan simpan alasan penyelesaian.", '<button class="button button-primary" data-action="new-incident"><i data-lucide="plus"></i> Catat insiden</button>')}
    <div class="callout" style="margin-bottom:14px"><i data-lucide="shield-alert"></i><p><strong>${openCount} insiden terbuka.</strong> Paket di luar manifest tidak otomatis menjadi paket rencana yang sah.</p></div>
    <section class="panel"><div class="panel-heading"><div><h2>Daftar insiden</h2><p>${state.incidents.length} catatan dengan jejak tindak lanjut</p></div><span class="status-pill ${openCount ? "partial" : "confirmed"}">${openCount} terbuka</span></div>${rows ? `<div class="table-wrap"><table><thead><tr><th>ID / WAKTU</th><th>KATEGORI</th><th>MANIFEST</th><th>NOMOR RESI</th><th>KETERANGAN</th><th>STATUS</th><th>TINDAKAN</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("triangle-alert", "Belum ada insiden", "Selisih atau paket di luar manifest akan tercatat di sini.")}</section>`;
}

function renderReports() {
  const packageRows = [];
  state.manifests.forEach((manifest) => manifest.packages.forEach((parcel) => packageRows.push({ manifest, parcel })));
  const totals = packageRows.reduce((result, entry) => {
    result.planned += entry.parcel.status !== "CANCELLED" ? 1 : 0;
    result.handed += entry.parcel.status === "HANDED_OVER" ? 1 : 0;
    result.open += ["EXPECTED", "SCANNED", "REJECTED", "EXCEPTION"].includes(entry.parcel.status) ? 1 : 0;
    return result;
  }, { planned: 0, handed: 0, open: 0 });
  const rows = [...state.manifests].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((manifest) => {
    const counts = getManifestCounts(manifest);
    return `<tr><td><button class="manifest-link" data-action="open-manifest" data-id="${escapeHtml(manifest.id)}">${escapeHtml(manifest.id)}</button></td><td>${escapeHtml(manifest.shop)}</td><td>${escapeHtml(manifest.courier)}</td><td>${formatDate(manifest.date)}</td><td>${counts.expected}</td><td>${counts.scanned}</td><td>${counts.handed}</td><td>${counts.outstanding}</td><td>${manifestStatusPill(manifest)}</td></tr>`;
  }).join("");
  content.innerHTML = `${pageHeading("ANALISIS OPERASIONAL", "Laporan rekonsiliasi", "Perbandingan paket rencana, pemindaian unik, dan daftar yang benar-benar diterima.", '<button class="button button-primary" data-action="export-report"><i data-lucide="download"></i> Ekspor CSV</button>')}
    <div class="report-summary"><div class="report-card"><span>Paket direncanakan</span><strong>${totals.planned}</strong></div><div class="report-card"><span>Diterima kurir</span><strong>${totals.handed}</strong></div><div class="report-card"><span>Belum terselesaikan</span><strong>${totals.open}</strong></div></div>
    <section class="panel"><div class="panel-heading"><div><h2>Rekonsiliasi per manifest</h2><p>Setiap kategori dihitung dari status paket, bukan total manual.</p></div></div>${rows ? `<div class="table-wrap"><table><thead><tr><th>MANIFEST</th><th>TOKO</th><th>KURIR</th><th>JADWAL</th><th>RENCANA</th><th>DIPINDAI</th><th>DITERIMA</th><th>SELISIH</th><th>STATUS</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("chart-no-axes-column-increasing", "Belum ada data", "Data rekonsiliasi akan tampil setelah manifest dibuat.")}</section>
    <div class="footer-note">Ekspor memuat nomor pesanan, resi, toko, kurir, jadwal, status paket, dan manifest. Data pelanggan yang tidak diperlukan tidak disertakan.</div>`;
}

function renderAudit() {
  const rows = state.audit.slice(0, 250).map((entry) => `<div class="audit-entry"><span class="audit-icon"><i data-lucide="history"></i></span><p><strong>${escapeHtml(entry.actor)}</strong> ${escapeHtml(entry.action)}<span class="cell-secondary">Objek: ${escapeHtml(entry.object)}</span></p><small>${formatDateTime(entry.createdAt)}</small></div>`).join("");
  content.innerHTML = `${pageHeading("JEJAK PERUBAHAN", "Audit log", "Riwayat tindakan operasional yang tercatat di browser ini.", '<button class="button button-secondary" data-action="export-audit"><i data-lucide="download"></i> Ekspor log</button>')}
    <section class="panel"><div class="panel-heading"><div><h2>Aktivitas terbaru</h2><p>Menampilkan hingga 250 catatan terbaru.</p></div><span class="status-pill">${state.audit.length} catatan</span></div>${rows || emptyState("history", "Belum ada aktivitas", "Perubahan pada manifest dan paket akan tercatat di sini.")}</section>
    <div class="footer-note">Audit log pada versi demo ini tersimpan di penyimpanan browser, bukan log server yang immutable. Pengguna dengan akses ke browser dapat mengubah data lokal.</div>`;
}

function openNewManifestModal() {
  openModal("Buat manifest manual", "Tambahkan paket yang akan diserahkan ke kurir.", `<form class="modal-form" id="new-manifest-form"><div class="modal-grid"><div class="field"><label for="new-shop">Toko <span class="required-mark">*</span></label><input id="new-shop" name="shop" required value="D'Fixer Store" /></div><div class="field"><label for="new-courier">Kurir / ekspedisi <span class="required-mark">*</span></label><input id="new-courier" name="courier" required placeholder="Contoh: J&T Express" /></div><div class="field"><label for="new-date">Tanggal rencana <span class="required-mark">*</span></label><input id="new-date" name="date" type="date" required value="${todayISO()}" /></div><div class="field"><label for="new-location">Lokasi</label><input id="new-location" name="location" placeholder="Gudang / titik serah" /></div></div><div class="field"><label for="new-parcels">Nomor resi <span class="required-mark">*</span></label><textarea id="new-parcels" name="parcels" required placeholder="Satu nomor resi per baris"></textarea><span class="field-help">Nomor resi duplikat atau yang sudah ada pada manifest aktif akan ditolak.</span></div><div class="modal-actions"><button type="button" class="button button-secondary" data-action="close-modal">Batal</button><button type="submit" class="button button-primary"><i data-lucide="plus"></i> Buat manifest</button></div></form>`);
}

function submitNewManifest(form) {
  const data = new FormData(form);
  const trackingNumbers = String(data.get("parcels") || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (!trackingNumbers.length) return toast("Masukkan minimal satu nomor resi.", true);
  const seen = new Set();
  for (const tracking of trackingNumbers) {
    const key = normalize(tracking);
    if (seen.has(key)) return toast(`Nomor resi ${tracking} tercantum lebih dari sekali.`, true);
    if (state.manifests.some((manifest) => manifest.packages.some((parcel) => trackingScope(parcel.tracking, manifest.shop, manifest.courier, manifest.date) === trackingScope(tracking, String(data.get("shop")).trim(), String(data.get("courier")).trim(), String(data.get("date")))))) return toast(`Resi ${tracking} sudah ada pada manifest untuk toko, kurir, dan tanggal tersebut.`, true);
    seen.add(key);
  }
  const manifest = createManifest({ shop: String(data.get("shop")).trim(), courier: String(data.get("courier")).trim(), date: String(data.get("date")), location: String(data.get("location") || "").trim(), parcels: trackingNumbers.map((tracking) => ({ tracking, order: tracking })), source: "manual" });
  logAudit(`Manifest dibuat manual dengan ${trackingNumbers.length} paket`, manifest.id);
  persist();
  closeModal();
  selectedManifestId = manifest.id;
  currentView = "manifest-detail";
  renderPage();
  toast(`Manifest ${manifest.id} dibuat.`);
}

function openNewIncidentModal() {
  const options = state.manifests.map((manifest) => `<option value="${escapeHtml(manifest.id)}">${escapeHtml(manifest.id)} · ${escapeHtml(manifest.courier)}</option>`).join("");
  openModal("Catat insiden", "Simpan konteks dan nomor resi agar selisih dapat ditelusuri.", `<form class="modal-form" id="new-incident-form"><div class="modal-grid"><div class="field"><label for="incident-category">Kategori <span class="required-mark">*</span></label><select id="incident-category" name="category" required><option>Paket kurang</option><option>Paket berlebih</option><option>Resi duplikat</option><option>Paket di luar manifest</option><option>Paket ditolak kurir</option><option>Kesalahan impor</option><option>Paket telah diserahkan sebelumnya</option><option>Kesalahan pemindaian</option><option>Masalah lain</option></select></div><div class="field"><label for="incident-manifest">Manifest terkait</label><select id="incident-manifest" name="manifestId"><option value="">Tidak terkait</option>${options}</select></div></div><div class="field"><label for="incident-tracking">Nomor resi</label><input id="incident-tracking" name="tracking" placeholder="Opsional" /></div><div class="field"><label for="incident-description">Deskripsi <span class="required-mark">*</span></label><textarea id="incident-description" name="description" required placeholder="Jelaskan kejadian dan tindakan yang diperlukan"></textarea></div><div class="modal-actions"><button type="button" class="button button-secondary" data-action="close-modal">Batal</button><button type="submit" class="button button-primary"><i data-lucide="triangle-alert"></i> Simpan insiden</button></div></form>`);
}

function submitIncident(form) {
  const data = new FormData(form);
  const incident = { id: makeId("INC"), category: String(data.get("category")), manifestId: String(data.get("manifestId") || ""), tracking: String(data.get("tracking") || "").trim(), description: String(data.get("description") || "").trim(), reportedBy: ACTOR, createdAt: nowISO(), status: "OPEN", resolution: "" };
  state.incidents.unshift(incident);
  logAudit(`Insiden dicatat: ${incident.category}`, incident.id);
  persist();
  closeModal();
  currentView = "incidents";
  renderPage();
  toast(`Insiden ${incident.id} tercatat.`);
}

function openResolveModal(id) {
  const incident = state.incidents.find((item) => item.id === id);
  if (!incident) return;
  openModal("Selesaikan insiden", `${incident.id} · ${incident.category}`, `<form class="modal-form" id="resolve-incident-form" data-id="${escapeHtml(id)}"><div class="field"><label for="resolution">Tindakan perbaikan <span class="required-mark">*</span></label><textarea id="resolution" name="resolution" required placeholder="Catat hasil pemeriksaan dan alasan penutupan"></textarea></div><div class="modal-actions"><button type="button" class="button button-secondary" data-action="close-modal">Batal</button><button type="submit" class="button button-primary"><i data-lucide="check"></i> Tandai selesai</button></div></form>`);
}

function resolveIncident(form) {
  const incident = state.incidents.find((item) => item.id === form.dataset.id);
  const resolution = String(new FormData(form).get("resolution") || "").trim();
  if (!incident || !resolution) return;
  incident.status = "RESOLVED";
  incident.resolution = resolution;
  incident.resolvedAt = nowISO();
  incident.resolvedBy = ACTOR;
  logAudit(`Insiden diselesaikan: ${incident.category} — ${resolution}`, incident.id);
  persist();
  closeModal();
  renderPage();
  toast("Insiden ditutup dan tindak lanjut dicatat.");
}

function csvCell(value) {
  let safe = String(value ?? "");
  if (/^[\s]*[=+@\-]/.test(safe)) safe = `'${safe}`;
  return `"${safe.replaceAll('"', '""')}"`;
}

function downloadCsv(filename, headers, rows) {
  const content = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF", content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function exportReport() {
  const rows = [];
  state.manifests.forEach((manifest) => manifest.packages.forEach((parcel) => {
    rows.push([manifest.id, manifest.shop, manifest.courier, manifest.date, parcel.order, parcel.tracking, PACKAGE_LABELS[parcel.status] || parcel.status, parcel.scannedAt || "", (manifest.sessions || []).filter((session) => session.items.includes(parcel.tracking)).map((session) => `${session.id}:${session.receiver}`).join(" | ")]);
  }));
  downloadCsv(`orderguard-rekonsiliasi-${todayISO()}.csv`, ["ID Manifest", "Toko", "Kurir", "Tanggal", "Nomor Pesanan", "Nomor Resi", "Status Paket", "Waktu Pindai", "Sesi Penerimaan"], rows);
  logAudit("Laporan rekonsiliasi diekspor", "CSV");
  persist();
}

function exportAudit() {
  downloadCsv(`orderguard-audit-${todayISO()}.csv`, ["Waktu", "Aktor", "Tindakan", "Objek"], state.audit.map((entry) => [entry.createdAt, entry.actor, entry.action, entry.object]));
}

function exportFailedRows(id) {
  const job = state.importJobs.find((item) => item.id === id);
  if (!job) return;
  downloadCsv(`baris-gagal-${job.fileName.replace(/\.[^.]+$/, "")}.csv`, ["Nomor Baris", "Nomor Pesanan", "Nomor Resi", "Alasan"], job.errors.map((item) => [item.line, item.order, item.tracking, item.issue]));
}

function showEvidence(sessionId) {
  const manifest = getManifest(selectedManifestId);
  const session = manifest?.sessions.find((item) => item.id === sessionId);
  if (!session?.evidence) return;
  openModal("Bukti foto penerimaan", `${session.id} · ${session.items.length} paket · ${formatDateTime(session.createdAt)}`, `<img src="${session.evidence}" alt="Bukti foto sesi ${escapeHtml(session.id)}" style="display:block;width:100%;max-height:62vh;object-fit:contain;border-radius:5px;background:#f2f3f1" /><div class="modal-actions" style="margin-top:12px"><button type="button" class="button button-secondary" data-action="close-modal">Tutup</button></div>`);
}

function changeManifestStatus(id, action) {
  const manifest = getManifest(id);
  if (!manifest) return;
  if (action === "close-manifest") {
    if (getManifestCounts(manifest).outstanding > 0 || state.incidents.some((incident) => incident.manifestId === id && incident.status === "OPEN")) return toast("Selesaikan semua paket dan insiden sebelum menutup manifest.", true);
    manifest.status = "CLOSED";
    logAudit("Manifest ditutup", manifest.id);
  } else {
    if (manifest.packages.some((parcel) => parcel.status === "HANDED_OVER")) return toast("Manifest yang sudah memiliki penerimaan tidak dapat dibatalkan. Buat koreksi melalui insiden.", true);
    if (!window.confirm(`Batalkan manifest ${manifest.id}? Tindakan ini tercatat.`)) return;
    manifest.status = "CANCELLED";
    manifest.packages.forEach((parcel) => { if (parcel.status !== "HANDED_OVER") parcel.status = "CANCELLED"; });
    logAudit("Manifest dibatalkan", manifest.id);
  }
  persist();
  renderPage();
  toast(action === "close-manifest" ? "Manifest ditutup." : "Manifest dibatalkan.");
}

function openHelp() {
  openModal("Tentang OrderGuard", "Demo MVP untuk alur kontrol manifest dan serah terima.", `<div class="help-copy"><p><strong>Yang tersedia:</strong> impor CSV/XLSX dengan pemetaan dan laporan validasi, manifest, scanner keyboard/kamera yang didukung browser, rekonsiliasi per paket, serah terima parsial, insiden, audit log, serta ekspor CSV.</p><p><strong>Penyimpanan:</strong> data tersimpan pada localStorage browser ini. File impor dan foto bukti diproses di perangkat; pembaca XLSX dimuat dari CDN saat diperlukan.</p><p><strong>Batas demo:</strong> belum ada login, backend, isolasi tenant, otorisasi server, sinkronisasi perangkat, backup terkelola, atau log immutable. Jangan gunakan data produksi.</p><p>Untuk membaca barcode dengan kamera, gunakan browser yang mendukung BarcodeDetector dan berikan izin kamera. Scanner USB/Bluetooth keyboard serta entri manual tetap dapat digunakan.</p></div><div class="modal-actions"><button type="button" class="button button-primary" data-action="close-modal">Mengerti</button></div>`);
}

document.addEventListener("click", async (event) => {
  const nav = event.target.closest("[data-view]");
  if (nav) {
    if (!hasAccess(nav.dataset.view)) {
      toast('Anda tidak memiliki izin untuk membuka halaman ini.', true);
      return;
    }
    currentView = nav.dataset.view;
    selectedManifestId = null;
    renderPage();
    return;
  }
  const action = event.target.closest("[data-action]");
  if (action) {
    const { action: name, id } = action.dataset;
    if (name === "go-import") { if (!hasAccess('imports')) return toast('Anda tidak memiliki izin untuk impor data.', true); currentView = "imports"; selectedManifestId = null; renderPage(); }
    else if (name === "go-manifests") { if (!hasAccess('manifests')) return toast('Anda tidak memiliki izin untuk mengakses manifest.', true); currentView = "manifests"; selectedManifestId = null; renderPage(); }
    else if (name === "new-manifest") { if (!hasAccess('imports')) return toast('Hanya Store Admin atau Super Admin yang dapat membuat manifest manual.', true); openNewManifestModal(); }
    else if (name === "new-incident") { if (!hasAccess('incidents')) return toast('Anda tidak memiliki izin untuk mencatat insiden.', true); openNewIncidentModal(); }
    else if (name === "open-manifest") { if (!hasAccess('manifests')) return toast('Anda tidak memiliki izin untuk membuka manifest.', true); selectedManifestId = id; currentView = "manifest-detail"; renderPage(); }
    else if (name === "back-manifests") { if (!hasAccess('manifests')) return toast('Anda tidak memiliki izin untuk membuka manifest.', true); selectedManifestId = null; currentView = "manifests"; renderPage(); }
    else if (name === "close-modal") closeModal();
    else if (name === "commit-import") { if (!hasAccess('imports')) return toast('Anda tidak memiliki izin untuk impor data.', true); commitImport(); }
    else if (name === "resolve-incident") { if (!hasAccess('incidents')) return toast('Anda tidak memiliki izin untuk menyelesaikan insiden.', true); openResolveModal(id); }
    else if (name === "export-report") { if (!hasAccess('reports')) return toast('Anda tidak memiliki izin untuk mengakses laporan.', true); exportReport(); }
    else if (name === "export-audit") { if (!hasAccess('audit')) return toast('Anda tidak memiliki izin untuk melihat audit log.', true); exportAudit(); }
    else if (name === "export-failed") exportFailedRows(id);
    else if (name === "view-evidence") showEvidence(id);
    else if (name === "close-manifest" || name === "cancel-manifest") { if (!hasAccess('imports')) return toast('Anda tidak memiliki izin untuk mengubah status manifest.', true); changeManifestStatus(id, name); }
    return;
  }
  if (event.target === modalBackdrop) closeModal();
});

document.addEventListener("submit", async (event) => {
  if (event.target.id === "login-form") {
    event.preventDefault();
    const formData = new FormData(event.target);
    const username = String(formData.get('username') || '').trim();
    const password = String(formData.get('password') || '').trim();
    try {
      await login(username, password);
    } catch (error) {
      toast(error.message, true);
    }
    return;
  }

  if (event.target.id === "scan-form") {
    event.preventDefault();
    const manifest = getManifest(selectedManifestId);
    const input = document.querySelector("#scan-input");
    if (manifest) recordScan(manifest, input.value);
  } else if (event.target.id === "handover-form") {
    event.preventDefault();
    confirmHandover(event.target);
  } else if (event.target.id === "new-manifest-form") {
    event.preventDefault();
    submitNewManifest(event.target);
  } else if (event.target.id === "new-incident-form") {
    event.preventDefault();
    submitIncident(event.target);
  } else if (event.target.id === "resolve-incident-form") {
    event.preventDefault();
    resolveIncident(event.target);
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "manifest-search") filterManifestRows();
});

document.addEventListener("change", async (event) => {
  if (event.target.id === "manifest-status-filter") filterManifestRows();
  else if (event.target.matches("[data-map]")) renderImportPreview();
  else if (event.target.id === "import-file" && event.target.files[0]) {
    const file = event.target.files[0];
    try { await readImportFile(file); }
    catch (error) { importDraft = null; renderImports(); toast(error.message, true); }
  } else if (event.target.id === "camera-toggle") toggleCamera();
});

document.addEventListener("click", async (event) => {
  const miniRole = event.target.closest(".mini-role");
  if (miniRole) {
    const username = miniRole.dataset.user;
    const password = miniRole.dataset.pass;
    try {
      await login(username, password);
    } catch (error) {
      toast(error.message, true);
    }
    return;
  }

  if (event.target.closest("#camera-toggle")) toggleCamera();
  const chooseFileButton = event.target.closest("#choose-file");
  if (chooseFileButton) { event.preventDefault(); document.querySelector("#import-file")?.click(); }
  if (event.target.closest("#help-button")) openHelp();
  if (event.target.closest("#menu-toggle")) document.querySelector("#sidebar").classList.toggle("open");
  if (event.target.closest("#logout-button")) {
    await logout();
  }

  const nav = event.target.closest("[data-view]");
  if (nav) {
    if (!ensureAccess(nav.dataset.view)) return;
  }
});

document.addEventListener("dragover", (event) => {
  if (event.target.closest("#upload-zone")) { event.preventDefault(); document.querySelector("#upload-zone")?.classList.add("dragover"); }
});
document.addEventListener("dragleave", (event) => {
  if (event.target.closest("#upload-zone")) document.querySelector("#upload-zone")?.classList.remove("dragover");
});
document.addEventListener("drop", async (event) => {
  if (!event.target.closest("#upload-zone")) return;
  event.preventDefault();
  document.querySelector("#upload-zone")?.classList.remove("dragover");
  const file = event.dataTransfer.files[0];
  if (!file) return;
  try { await readImportFile(file); }
  catch (error) { importDraft = null; renderImports(); toast(error.message, true); }
});

document.querySelector("#today-date").textContent = new Intl.DateTimeFormat("id-ID", { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date());
(async () => {
  const session = await getSession();
  if (session) {
    await hydrateStateFromServer();
  }
  renderPage();
})();