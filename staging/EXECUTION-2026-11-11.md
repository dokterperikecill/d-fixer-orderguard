# Laporan Eksekusi P0 — Kesiapan Produksi
**Tanggal:** 2026-11-11 (Asia/Jakarta)
**Repo:** `/root/d-fixer-orderguard`
**Branch:** `fix/wave-2.3-staging-verification`
**HEAD:** `8877adf` + perubahan P0 pada working tree (belum di-commit)
**Lingkungan:** VPS `vps.ayra.id` — Ubuntu 24.04.5, PostgreSQL 16.15, Nginx 1.24.0
**Runtime staging:** Node.js **v24.22.2** (binary terisolasi `/opt/node24`)

---

## 1. Ringkasan

| P0 | Status | Bukti utama |
|---|---|---|
| P0-1 Staging verification | 🟡 **Sebagian** — rehearsal staging dieksekusi; deployment Render belum | 29/29 smoke HTTPS, 3/3 E2E staging |
| P0-2 Backup/restore drill + runner | ✅ **Lulus** | 6/6 langkah drill, 20 baris / 9 tabel, wrong key & tamper ditolak |
| P0-3 Graceful shutdown | ✅ **Lulus** | 30/30 request in-flight sukses, exit `0` |
| P0-4 Monitoring & alerting | ✅ **Lulus** | Metrics, JSON log, healthcheck, alert webhook teruji |
| P0-5 Node version drift | ✅ **Lulus** | `engines`, `.nvmrc`, CI `node-version-file`, staging di Node 24.22.2 |
| Regresi | ✅ **Tidak ada** | 58/58 backend, 8/8 E2E, 650 tx load 0 error (Node 24) |

**Kesimpulan:** seluruh gap P0 yang dapat diselesaikan di dalam repo dan lingkungan uji **sudah ditutup dan diverifikasi**. Satu item tetap terbuka secara operasional: **deployment ke staging Render/Render project terpisah** (butuh akun, database, bucket, domain, dan persetujuan) serta **checklist fungsional penuh di staging**.

---

## 2. Lingkungan staging rehearsal

| Item | Nilai |
|---|---|
| URL | `https://staging-orderguard.202-10-34-141.nip.io` |
| TLS | Let's Encrypt, valid s/d 2027-02-09 |
| Akses | Nginx `allow 127.0.0.1/::1; deny all` (tidak publik) |
| App | `orderguard-staging.service`, user `dfixer-admin`, port `4181` |
| Runtime | Node v24.22.2 |
| Database | `orderguard_staging` (terpisah), restore target `orderguard_staging_restore` |
| Mode | `NODE_ENV=production` |
| Bootstrap | Admin dibuat sekali, lalu `ORDERGUARD_BOOTSTRAP_*` dihapus dari environment |
| Data | Sintetis; tidak ada data produksi |
| Secrets | DB password, bootstrap, metrics token, backup key dibuat baru (root-only, `600`) |

---

## 3. Detail hasil

### P0-3 — Graceful shutdown
Implementasi di `server.js`:
- Handler `SIGTERM`/`SIGINT`, `server.close()`, `closeIdleConnections()`, drain pool, exit `0`.
- Timeout paksa `ORDERGUARD_SHUTDOWN_TIMEOUT_MS` (default 25 dtk).
- `unhandledRejection`/`uncaughtException` tercatat dan memicu shutdown terkontrol.
- HTTP timeout: headers 20 dtk, request 30 dtk, keep-alive 65 dtk.

**Drill:** 30 request `GET /api/state` in-flight → `SIGTERM` saat `inflight=31` (termasuk probe metrics):

```json
{ "inflightAtSignal": 31, "requests": 30, "success": 30, "errors": [], "non200": [], "processGone": true }
```

Journal: `shutdown_complete ... code: 0` → `Deactivated successfully`.

Tes otomatis: `ops.test.js` (3 test) memverifikasi readiness, metrics terproteksi, dan `SIGTERM` keluar `0`.

### P0-4 — Monitoring & alerting
- `GET /api/health` → liveness (`status`, uptime, release, runtime), tanpa DB.
- `GET /api/ready` → readiness DB (`SELECT 1`), dipakai `render.yaml healthCheckPath`.
- `GET /api/metrics` → Prometheus (request, kelas status, 5xx, `db_up`, `inflight`, uptime, RSS); 404 jika token kosong, 401 jika token salah, 200 dengan Bearer token.
- Log akses JSON per request dengan `X-Request-Id`, method, path, status, durasi; tidak mencatat IP mentah/cookie/body.
- `scripts/alert.js` + webhook Slack/generic; dipanggil oleh backup, restore, dan restore drill saat gagal.
- `scripts/healthcheck.js` + `npm run ops:healthcheck`; unit systemd di `ops/systemd/`; workflow `.github/workflows/ops-healthcheck.yml`.

**Bukti:**
- Healthcheck staging: `{"event":"healthcheck_ok","status":200,"durationMs":494}`
- Healthcheck gagal (URL mati) memicu webhook: `[CRITICAL] OrderGuard health check error — fetch failed`
- Alert manual terkirim: `{"sent":true,"status":200}`
- Metrics setelah load: `requests_total 469`, `responses 2xx 450`, `4xx 4`, `5xx 0`, `db_up 1`

### P0-5 — Node version
- `package.json` → `"engines": { "node": ">=24.0.0 <25" }`
- `.nvmrc` → `24`
- CI memakai `node-version-file: .nvmrc`
- Staging dijalankan dengan Node **v24.22.2** (bukan Node 22 sistem).

Seluruh pengujian akhir dijalankan ulang dengan Node 24:
- Backend/unit: **58/58 lulus** (135,7 dtk)
- Browser E2E: **8/8 lulus** (2,0 mnt)
- Load lokal: **650 transaksi, 0 error**

### P0-2 — Backup/restore drill
`scripts/drill-restore.js` (`npm run db:drill`) menjalankan:
1. backup terenkripsi AES-256-GCM,
2. restore ke database terpisah,
3. perbandingan jumlah baris,
4. penolakan key salah,
5. penolakan ciphertext termodifikasi.

**Hasil:**

```json
{
  "status": "pass",
  "sourceDatabase": "orderguard_staging",
  "targetDatabase": "orderguard_staging_restore",
  "backupFile": "orderguard-20261111T102336Z.dump.enc",
  "durationMs": 7306,
  "counts": { "tables": 9, "rows": 20 }
}
```

| Langkah | Status |
|---|---|
| encrypted_backup | PASS (1.209 ms) |
| restore_to_separate_database | PASS (5.497 ms) |
| row_count_match | PASS (9 tabel, 20 baris) |
| wrong_key_rejected | PASS (exit 1) |
| tampered_ciphertext_rejected | PASS (exit 1) |

**Runner:** `ops/backup/Dockerfile` (Node 24 + `postgresql-client-16` + AWS CLI + rclone + tini), unit systemd, dan `render.yaml` cron diubah ke `runtime: docker`. Build image belum dieksekusi di VPS ini karena Docker tidak terpasang; verifikasi build dilakukan saat provisioning staging/produksi.

### P0-1 — Staging verification
**Sudah dieksekusi (rehearsal di VPS):**
- Deploy manual dari working tree, `NODE_ENV=production`, DB terpisah, TLS valid, akses dibatasi localhost.
- Bootstrap admin berhasil; environment bootstrap dihapus; login tetap berhasil setelah restart.
- Smoke keamanan **29/29 PASS**: health, readiness, HSTS, CSP, X-Frame-Options, Referrer/Permissions-Policy, cookie `HttpOnly/Secure/SameSite=Lax/Path=/`, CSRF `403 CSRF_INVALID`, origin asing `403 ORIGIN_REJECTED`, unauthorized `401`, rate limit `429`, logout invalidasi sesi.
- E2E staging **3/3 PASS** (login/session/cookie/logout, PWA manifest + header, service worker HTTPS).
- Load read-only staging: **400 transaksi, 0 error**; p95 health 603 ms, session 471 ms, state 330 ms (Node 24).
- Rollback drill: **N (`8877adf`) → N-1 (`4a0a030`) → N**, round-trip **8 detik**; health, login+CSRF, dan `/api/state` tetap berfungsi; worktree dibersihkan.
- Backup/restore drill (lihat P0-2).

**Belum dieksekusi (butuh staging Render/sungguhan):**
- Provision project Render terpisah, PostgreSQL staging, bucket S3/R2, IAM least privilege, Cloudflare Access.
- Checklist fungsional penuh: impor CSV/XLSX, scan/duplikat, handover + evidence, finalisasi manifest, rekonsiliasi, quarantine UI lintas tenant, laporan.
- TikTok Shop staging (app terpisah) dan pengujian scope/endpoint.
- PWA upgrade cache v9 → v10 di perangkat nyata.
- Backup off-site nyata (S3/rclone) dan alert channel produksi.
- Build/verifikasi image backup runner di Render.
- Rollback drill terhadap deploy Render (bukan proses lokal).

---

## 4. Perubahan kode

| File | Perubahan |
|---|---|
| `server.js` | Graceful shutdown, `/api/ready`, metrics + inflight, request ID, JSON access log, timeout HTTP, structured error log |
| `ops.test.js` | 3 test runtime/ops |
| `scripts/alert.js` | Webhook alert Slack/generic |
| `scripts/healthcheck.js` | Readiness probe + alert |
| `scripts/drill-restore.js` | Drill backup→restore→compare→negative tests |
| `scripts/backup.js`, `scripts/restore.js` | Alert saat gagal |
| `scripts/staging-smoke.js` | 28–29 pemeriksaan staging |
| `scripts/load-test.js` | Mode `--external` read-only |
| `playwright.staging.config.js`, `e2e-staging/` | E2E staging tanpa seeding |
| `ops/` | Dockerfile backup runner, systemd units, README |
| `.github/workflows/ops-healthcheck.yml`, `ci.yml` | Healthcheck terjadwal, Node dari `.nvmrc` |
| `render.yaml` | `healthCheckPath: /api/ready`, cron backup Docker |
| `package.json`, `.nvmrc` | Pin Node 24, script ops/staging/drill |
| `OPERATIONS.md`, `TESTING.md`, `SECURITY.md`, `staging/*` | Dokumentasi dan status eksekusi |

Tidak ada secret yang ditulis ke repo. `git grep` tidak menemukan `.env`, DB, atau key.

---

## 5. Catatan risiko yang masih ada (bukan P0)

- Model `tenant_state` JSON penuh masih menyerialkan write per tenant; load test mencatat 409 retry pada konkurensi tinggi.
- `scryptSync` masih berjalan di event loop; rate limit membatasi, tetapi beban login ekstrem dapat memblokir proses.
- Aset pihak ketiga (`lucide`, `xlsx`, Google Fonts) dimuat dari CDN tanpa SRI.
- Belum ada MFA, reset password mandiri, atau UI manajemen sesi.
- Staging rehearsal berada di VPS yang sama dengan Clockin/Parkline (DB dan key terpisah); bukan isolasi infrastruktur penuh seperti Render.

---

## 6. Artefak

Seluruh bukti disalin ke **`/root/security-backups/orderguard-p0-20261111/`** (root, `700`):

| Artefak | Lokasi |
|---|---|
| Laporan ini | `EXECUTION-2026-11-11.md` |
| Smoke staging (28/28) | `smoke-staging.json` |
| Load staging | `load-staging.json` |
| Drill report + backup terenkripsi | `drill-report.json`, `drill-backups/` |
| Shutdown drill | `shutdown-drill.json` |
| Metrik Prometheus | `metrics-snapshot.txt` |
| Log test Node 24 | `test-node24.log` |
| Log E2E Node 24 | `e2e-node24.log` |
| Log load Node 24 | `load-node24.log` |
| Konfigurasi Nginx staging | `nginx-orderguard-staging.conf` |
| Unit systemd staging | `orderguard-staging.service` |

Kredensial staging (rahasia, root-only):

- `/root/orderguard-staging-credentials.txt` (`600`)
- `/root/orderguard-staging-backup-key` (`600`)

Hentikan/menonaktifkan rehearsal:

```sh
sudo systemctl disable --now orderguard-staging.service
# optional cleanup: hapus DB orderguard_staging & orderguard_staging_restore,
# site nginx orderguard-staging, cert, baris /etc/hosts, dan /etc/orderguard/staging.env
```

---

## 7. Rekomendasi berikutnya

1. Review dan commit perubahan P0 pada branch ini; jangan merge ke `main` sebelum staging Render lulus.
2. Provision staging Render sesuai `staging/DEPLOYMENT.md`, lalu jalankan:
   - `npm run staging:smoke`
   - `npm run e2e:staging`
   - `npm run load:staging`
   - `npm run db:drill`
3. Jalankan checklist fungsional penuh dan rollback drill pada deploy Render.
4. Setelah lulus, baru pertimbangkan merge `main` dan rilis produksi.
