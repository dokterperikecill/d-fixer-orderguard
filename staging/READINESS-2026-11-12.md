# Staging Readiness Report — OrderGuard
**Tanggal:** 2026-11-12 (Asia/Jakarta)
**Status:** ✅ **STAGING CORE SIAP** — dengan 3 item eksternal yang ditandai *blocked*
**Release:** `staging-2026-11-12` → commit **`84d8b69`**
**Artefak deploy:** `/opt/orderguard-staging/releases/84d8b69` (symlink `current`)
> Tag `staging-2026-11-12` menunjuk ke commit runtime `84d8b69`; commit tooling/dokumentasi setelahnya tidak mengubah runtime yang diuji.
**Lingkungan:** VPS `vps.ayra.id` — Ubuntu 24.04.5, Node **v24.22.2**, PostgreSQL 16.15, Nginx 1.24.0

> Laporan rehearsal awal: [`EXECUTION-2026-11-11.md`](EXECUTION-2026-11-11.md).
> Panduan akses: [`ACCESS.md`](ACCESS.md).

---

## 1. Arsitektur staging

```text
Operator (SSH tunnel / allowlist)
        |
        v
Nginx TLS :443  staging-orderguard.202-10-34-141.nip.io
  allow 127.0.0.1/::1; deny all
        |
        v
127.0.0.1:4181  orderguard-staging.service
  User=orderguard, Node 24, MemoryMax=384M, CPUQuota=50%
  ProtectSystem=strict, ProtectHome, PrivateTmp, NoNewPrivileges
        |
        v
PostgreSQL 16 localhost — orderguard_staging
  (restore target: orderguard_staging_restore)
        |
        v
Backup harian terenkripsi -> /var/backups/orderguard-staging
  (off-site: BELUM dikonfigurasi)
```

| Item | Nilai |
|---|---|
| Domain | `staging-orderguard.202-10-34-141.nip.io` |
| TLS | Let's Encrypt, valid s/d 2027-02-09, auto-renew |
| Akses publik | **HTTP 403** (allowlist localhost) |
| App bind | `127.0.0.1:4181` (bukan `0.0.0.0`) |
| Runtime user | `orderguard` (system, nologin) |
| Deploy | release per SHA + symlink `current` |
| Bootstrap | admin dibuat sekali, env bootstrap sudah dihapus |
| Data | sintetis; tenant `dfixer-store` + `maya-commerce` |

---

## 2. Bukti eksekusi final

### 2.1 Build & deploy
- `npm ci --omit=dev` berhasil **tanpa compiler native** (82 paket, 5,5 MB) setelah `better-sqlite3` dipindah ke devDependencies.
- `/api/health` → `version: staging-2026-11-12`, `runtime: v24.22.2`.
- `/api/ready` → `status: ready`, `database: ok`.
- Service aktif, `User=orderguard`, `MemoryMax=402653184`, `CPUQuota=500ms`, listen `127.0.0.1:4181`.
- Publik: `HTTP 403`; port 4181 tidak terbuka di UFW (hanya 22/80/443).

### 2.2 Backend & unit test
- **58/58 lulus**, 0 fail (Node 24), termasuk 3 test ops baru.
- `npm audit --omit=dev`: **0 vulnerability** (critical/high/moderate/low = 0).

### 2.3 Browser E2E staging — **9/9 lulus**
| Test | Cakupan |
|---|---|
| Login, tenant isolation, logout | kredensial salah, isolasi `Maya Commerce` vs `D'Fixer Store` |
| CSV & XLSX import | kedua format menghasilkan manifest tervalidasi |
| Scan/handover/evidence/finalisasi | scan valid, duplikat, di luar manifest, foto bukti, tutup manifest |
| Reports | laporan rekonsiliasi tersedia |
| Quarantine | preview, recovery, audit history, isolasi tenant lain |
| Session expiry | sesi kedaluwarsa ditolak |
| PWA & header | manifest, service worker HTTPS, CSP/HSTS/X-Frame-Options |
| Cookie & logout | `HttpOnly`, `Secure`, `SameSite=Lax`, invalidasi sesi |

### 2.4 Security smoke — **29/29 lulus**
Health, readiness, HSTS, CSP, X-Frame-Options, Referrer/Permissions-Policy, cookie flags, CSRF `403`, origin asing `403`, unauthorized `401`, rate limit login `429`, logout invalidasi sesi.

### 2.5 Load staging (read-only) — **400 transaksi, 0 error**
| Endpoint | p95 |
|---|---:|
| `GET /api/health` | 602 ms |
| `GET /api/session` | 500 ms |
| `GET /api/state` | 268 ms |

Metrics (snapshot proses saat pengujian): `requests_total 626`, `5xx 0`, `server_errors_total 0`, `db_up 1`.

### 2.6 Backup & restore drill — **6/6 lulus**
| Langkah | Hasil |
|---|---|
| Encrypted backup (AES-256-GCM) | PASS |
| Restore ke DB terpisah | PASS |
| Row-count match | PASS — 9 tabel, **60 baris** |
| Wrong key rejected | PASS |
| Tampered ciphertext rejected | PASS |
| Durasi | 8,4 detik |

Backup terjadwal: `orderguard-staging-backup.timer`, harian 02:00, retensi 14, output `.dump.enc` + `.meta.json` + `.sha256` di `/var/backups/orderguard-staging` (owner `orderguard`, `700`). Eksekusi manual terakhir: **success**.

### 2.7 Rollback drill — **16 detik**
- N (`84d8b69`) → N-1 (`4ae86d2`) → N.
- Setelah rollback: `/api/health 200`, login + CSRF berhasil.
- Setelah kembali ke N: `/api/ready 200`, login berhasil.

### 2.8 Observability
- `orderguard-staging-healthcheck.timer` aktif tiap 5 menit; eksekusi manual **success** (`/api/ready`, durasi 685 ms, version sesuai tag).
- Log akses JSON + request ID; tidak memuat cookie/token/body.
- `/api/metrics` terproteksi token; `5xx 0`, `db_up 1`.

---

## 3. Item yang belum selesai (blocked eksternal)

| Item | Status | Alasan / yang dibutuhkan |
|---|---|---|
| **Backup off-site** | ⛔ blocked | Belum ada bucket S3/R2 atau remote rclone. Backup lokal terenkripsi sudah berjalan, tetapi belum memenuhi disaster recovery |
| **Channel alert eksternal** | ⛔ blocked | Belum ada URL Slack/WhatsApp/email. Healthcheck berjalan dan gagal akan tercatat di journal, tetapi belum mengirim notifikasi |
| **TikTok Shop staging** | ⏸ deferred | Butuh app TikTok staging terpisah, kredensial, toko uji, dan keputusan akses callback publik |
| **Deployment Render** | ⏸ deferred | Staging saat ini di VPS; Render tetap opsi untuk isolasi penuh |
| **Cloudflare Access** | ⏸ opsional | Butuh migrasi DNS `dfixer.cloud` dari Rumahweb ke Cloudflare |

---

## 4. Definition of Done

| Kriteria | Status |
|---|---|
| Deploy dari tag/SHA, versi cocok | ✅ |
| Publik 403, akses terkontrol | ✅ |
| Bootstrap dihapus, tanpa akun demo | ✅ |
| Data sintetis 2 tenant + 3 peran | ✅ |
| Smoke keamanan 100% | ✅ 29/29 |
| E2E fungsional 100% | ✅ 9/9 |
| Load 0 error | ✅ 400 tx |
| Backup + restore drill | ✅ 6/6 |
| Rollback drill | ✅ 16 dtk |
| Healthcheck + metrics | ✅ |
| Backup off-site | ⛔ |
| Alert channel eksternal | ⛔ |
| TikTok staging | ⏸ |

**Kesimpulan:** staging **layak dipakai untuk QA internal dan verifikasi fungsional** sekarang. Untuk menyatakan “production-like / DR-ready”, dua item wajib dilengkapi: **off-site backup** dan **alert channel**. TikTok dan Render bersifat opsional sesuai kebutuhan.

---

## 5. Operasional

```sh
# status
systemctl status orderguard-staging.service
systemctl list-timers 'orderguard-staging-*'

# deploy release baru
sudo git -C /root/d-fixer-orderguard fetch --tags
sudo bash /opt/orderguard-staging/deploy.sh <tag>   # bila script disediakan

# backup manual
sudo systemctl start orderguard-staging-backup.service

# healthcheck manual
sudo systemctl start orderguard-staging-healthcheck.service

# rollback: arahkan symlink current ke release sebelumnya, lalu restart
sudo ln -sfn /opt/orderguard-staging/releases/<sha-lama> /opt/orderguard-staging/current
sudo systemctl restart orderguard-staging.service
```

Kredensial (root-only): `/root/orderguard-staging-credentials.txt`, `/root/orderguard-staging-backup-key`.

Bukti lengkap: `/root/security-backups/orderguard-p0-20261111/` dan salinan final di `/root/security-backups/orderguard-staging-20261112/`.
