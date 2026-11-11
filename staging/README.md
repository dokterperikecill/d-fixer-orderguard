# Wave 2.3 — Production Staging Verification

**Status: PREPARATION ONLY.** Dokumen ini adalah hasil audit dan rancangan staging. Tidak ada deployment, merge, akses database produksi, atau penggunaan kredensial produksi pada tahap ini.

> **Update 2026-11-11:** rehearsal staging sudah dieksekusi di VPS (nginx TLS, PostgreSQL terpisah, Node 24) untuk area runtime, keamanan, backup/restore, rollback, dan observability. Deployment staging Render serta checklist fungsional penuh masih belum. Bukti: [`EXECUTION-2026-11-11.md`](EXECUTION-2026-11-11.md).

- Base branch: `fix/wave-2.2-local-hardening`
- Base commit: `4a0a030a176c5dbd3dd1672bbea0a4b21affa625`
- Branch kerja: `fix/wave-2.3-staging-verification`
- Lingkup tahap ini: audit infrastruktur, konfigurasi, deployment/rollback plan, dan checklist keamanan/verifikasi.

## A. Arsitektur Staging

```text
Pengguna / QA
    |
    | HTTPS + Cloudflare Access / IP allowlist
    v
+------------------------------+
| Staging web service          |
| Node.js 24 + Express         |
| Render Starter/Standard      |
| - static PWA                 |
| - REST API                   |
| - session + CSRF             |
+--------------+---------------+
               | private network / TLS
               v
+------------------------------+
| Staging PostgreSQL 16        |
| managed, private network     |
| - tenant_state (JSON)        |
| - audit, quarantine, TikTok  |
+--------------+---------------+
               |
               | encrypted logical backup
               v
+------------------------------+
| Object storage (S3/R2)       |
| bucket staging terpisah      |
| versioning + lifecycle       |
+--------------+---------------+
               ^
               | scheduled backup runner
+------------------------------+
| Backup runner                |
| Docker cron (disarankan)     |
| atau GitHub Actions          |
| pg_dump + aws/rclone         |
+------------------------------+

Opsional keluar:
- TikTok Shop API (staging app / disabled)
- Monitoring uptime dan log
```

### Karakteristik aplikasi yang memengaruhi staging

- **Satu proses Node.js** melayani API dan static PWA. Tidak ada worker, Redis, atau queue.
- **PostgreSQL adalah satu-satunya state store.** State operasional tenant disimpan sebagai JSON di `tenant_state`; bukti foto disimpan sebagai data URI di dalam JSON yang sama.
- **Web filesystem bersifat ephemeral.** Backup tidak boleh bergantung pada disk lokal web service.
- **Bukti foto maksimal 2 MB per gambar** setelah validasi server. Karena disimpan di JSON, ukuran database dan backup dapat tumbuh cepat.
- **Migrasi berjalan saat startup** dan bersifat additive: `CREATE TABLE/INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `ADD CONSTRAINT ... NOT VALID`, trigger `CREATE OR REPLACE`.
- **Tidak ada extension PostgreSQL khusus.** Aplikasi memakai `plpgsql`, `hashtext`, dan `pg_advisory_xact_lock` yang tersedia di PostgreSQL standar.
- **TikTok Shop bersifat opsional.** Tanpa konfigurasi TikTok, aplikasi tetap berjalan dan endpoint TikTok mengembalikan status belum dikonfigurasi.
- **PWA memakai cache shell** `dfixer-orderguard-shell-v10`; staging harus diuji dengan HTTPS agar service worker dan cookie `Secure` berfungsi.

### Isolasi dari produksi

Staging wajib terpisah pada seluruh lapisan:

| Lapisan | Produksi | Staging |
|---|---|---|
| Project/workspace | produksi | project staging terpisah |
| Database | produksi | database staging terpisah |
| Object storage | bucket produksi | bucket/prefix staging |
| Encryption key | key produksi | key staging baru |
| TikTok app | app produksi | app staging atau dinonaktifkan |
| Domain | domain produksi | host staging |
| Kredensial | secret produksi | secret staging baru |
| Data | data produksi | data sintetis |

## B. Daftar Kebutuhan Layanan

| Layanan | Kebutuhan | Rekomendasi staging | Catatan |
|---|---|---|---|
| Web compute | Node.js 24, 1 instance, health check `/api/health` | Render Starter (512 MB) minimum; Standard untuk uji beban | Filesystem ephemeral |
| PostgreSQL | PostgreSQL 16, private network, TLS | Render Postgres Basic-256MB minimum; Basic 1GB untuk uji data/bukti | Pin major version sesuai produksi |
| Object storage | S3-compatible, versioning, encryption | AWS S3 atau Cloudflare R2, bucket staging terpisah | Untuk backup terenkripsi |
| Secret management | Menyimpan DB URL, key, bootstrap, TikTok | Render environment secrets + password manager | Jangan simpan di repo |
| Access control | Membatasi akses staging | Cloudflare Access/Zero Trust atau IP allowlist | Staging tidak boleh terbuka publik |
| DNS/TLS | HTTPS untuk cookie `Secure`, HSTS, service worker | Render subdomain atau custom domain | TLS wajib |
| CI | Test backend, E2E, load per commit | GitHub Actions yang sudah ada | Wajib hijau sebelum deploy |
| Backup runner | `pg_dump`, `aws`/`rclone`, scheduler | Docker cron di private network (disarankan) atau GitHub Actions scheduled | Render native cron belum tentu punya CLI backup |
| Monitoring | Uptime, health, error log, backup alert | Render logs + UptimeRobot/Better Stack free tier | Minimal alert saat health gagal |
| TikTok staging | App key/secret/redirect terpisah | App staging atau kosongkan | Jangan memakai app produksi |
| Email/notifikasi | Tidak ada di aplikasi | Monitoring eksternal | Tidak perlu layanan email baru |

## C. Daftar Environment Variables

### Runtime aplikasi

| Variable | Wajib | Contoh / nilai staging | Secret | Catatan |
|---|---|---|---|---|
| `NODE_ENV` | Ya | `production` | Tidak | staging sengaja memakai mode production agar cookie `Secure`, HSTS, dan pemeriksaan akun demo aktif |
| `PORT` | Tidak | `4173` | Tidak | Render biasanya mengatur otomatis |
| `DATABASE_URL` | Ya | `postgresql://...?...sslmode=require` | **Ya** | database staging, bukan produksi |
| `DATABASE_SCHEMA` | Tidak | tidak diatur | Tidak | hanya untuk test/CI |
| `ORDERGUARD_TRUST_PROXY` | Ya di belakang proxy | `1` | Tidak | agar IP dan origin benar |
| `ORDERGUARD_ALLOWED_ORIGINS` | Ya | `https://staging.example.com` | Tidak | origin saja, tanpa wildcard/path |
| `ORDERGUARD_SESSION_HOURS` | Tidak | `8` | Tidak | default 8 |
| `ORDERGUARD_LOGIN_WINDOW_MINUTES` | Tidak | `15` | Tidak | default 15 |
| `ORDERGUARD_LOGIN_MAX_ATTEMPTS` | Tidak | `5` | Tidak | per username+IP |
| `ORDERGUARD_LOGIN_MAX_IP_ATTEMPTS` | Tidak | `20` | Tidak | per IP |
| `ORDERGUARD_BOOTSTRAP_USERNAME` | Hanya DB kosong | `staging-owner` | Tidak | hapus setelah bootstrap |
| `ORDERGUARD_BOOTSTRAP_PASSWORD` | Hanya DB kosong | password acak 20+ karakter | **Ya** | minimal 12 karakter; hapus setelah bootstrap |
| `ORDERGUARD_BOOTSTRAP_NAME` | Hanya DB kosong | `Staging Owner` | Tidak | hapus setelah bootstrap |
| `TIKTOK_APP_KEY` | Opsional | app staging | **Ya** | kosongkan jika TikTok dinonaktifkan |
| `TIKTOK_APP_SECRET` | Opsional | app staging | **Ya** | jangan pakai secret produksi |
| `TIKTOK_REDIRECT_URI` | Opsional | `https://staging.example.com/api/tiktok/callback` | Tidak | wajib HTTPS dan path callback |
| `ORDERGUARD_TOKEN_ENCRYPTION_KEY` | Opsional | 32-byte hex/base64 | **Ya** | wajib jika TikTok aktif; key staging terpisah |
| `TIKTOK_RETURNS_PATH` | Tidak | default | Tidak | default `/return_refund/202309/returns/search` |
| `ORDERGUARD_APP_URL` | Tidak | URL staging HTTPS | Tidak | hanya untuk desktop Electron, bukan web |

### Backup dan operasi

| Variable | Wajib | Contoh / nilai staging | Secret | Catatan |
|---|---|---|---|---|
| `ORDERGUARD_BACKUP_DIR` | Ya untuk runner | `/tmp/orderguard-backups` | Tidak | ephemeral; hasil diunggah ke object storage |
| `ORDERGUARD_BACKUP_ENCRYPTION_KEY` | Ya | 64 hex / base64 32 byte | **Ya** | key staging baru |
| `ORDERGUARD_BACKUP_PREVIOUS_ENCRYPTION_KEYS` | Tidak | kosong | **Ya** | hanya saat rotasi |
| `ORDERGUARD_BACKUP_NEW_ENCRYPTION_KEY` | Hanya rotasi | key baru | **Ya** | script rotasi |
| `ORDERGUARD_BACKUP_KEEP` | Tidak | `30` | Tidak | retensi lokal |
| `ORDERGUARD_BACKUP_OFFSITE_S3_URI` | Pilih salah satu | `s3://dfixer-staging-backups/orderguard/` | Tidak | bucket staging terpisah |
| `ORDERGUARD_BACKUP_OFFSITE_RCLONE_REMOTE` | Pilih salah satu | `staging-remote:orderguard/` | Tidak | alternatif S3 |
| `ORDERGUARD_BACKUP_OFFSITE_DIR` | Tidak | tidak diatur | Tidak | hanya mirror lokal, **bukan** off-site |
| `ORDERGUARD_BACKUP_ALLOW_PLAINTEXT` | Tidak | tidak diatur | Tidak | **jangan** aktifkan di staging |
| `ORDERGUARD_CONFIRM_RESTORE` | Hanya restore | nama DB target | Tidak | konfirmasi eksplisit |
| `ORDERGUARD_CONFIRM_ROTATE_KEYS` | Hanya rotasi | path direktori backup | Tidak | konfirmasi eksplisit |
| `ORDERGUARD_CONFIRM_INTEGRITY` | Hanya reconcile | nama DB | Tidak | konfirmasi eksplisit |
| `ORDERGUARD_CONFIRM_VALIDATE_CONSTRAINTS` | Hanya validasi | nama DB | Tidak | konfirmasi eksplisit |
| `ORDERGUARD_CONFIRM_QUARANTINE_PRUNE` | Hanya prune | nama DB | Tidak | konfirmasi eksplisit |
| `ORDERGUARD_QUARANTINE_RETENTION_DAYS` | Tidak | `90` | Tidak | prune manual |
| `AWS_ACCESS_KEY_ID` | Ya untuk S3 CLI | kredensial runner staging | **Ya** | IAM least privilege |
| `AWS_SECRET_ACCESS_KEY` | Ya untuk S3 CLI | kredensial runner staging | **Ya** | jangan pakai kredensial produksi |
| `AWS_REGION` | Ya untuk S3 CLI | `ap-southeast-1` | Tidak | sesuaikan bucket |
| `AWS_ENDPOINT_URL` | Jika S3-compatible | endpoint R2/B2 | Tidak | opsional |

### Hanya test/CI — jangan diatur di staging

`TEST_DATABASE_URL`, `E2E_SCHEMA`, `LOAD_TEST_PORT`, `LOAD_TEST_SCHEMA`, `ORDERGUARD_TEST_USERS`, `ORDERGUARD_TEST_SEED_DEMO`, `GITHUB_SHA`.

### Aturan secret

- Jangan commit nilai secret ke repository.
- Jangan memakai kredensial produksi.
- Jangan mencetak secret ke log; gunakan masking platform.
- Ganti seluruh secret staging jika pernah bocor.
- Hapus `ORDERGUARD_BOOTSTRAP_PASSWORD` dari environment setelah admin pertama dibuat.

Template tanpa nilai secret: `staging/staging.env.example`.

## D. Estimasi Biaya Bulanan

Estimasi indikatif, bukan penawaran. Harga publik berubah; verifikasi saat provisioning. Referensi publik 2026: Render Starter web sekitar $7/bulan, Render Postgres Basic-256MB sekitar $6/bulan, storage Postgres sekitar $0.30/GB/bulan, S3 Standard sekitar $0.023/GB/bulan.

### Skenario minimal

| Komponen | Asumsi | Estimasi |
|---|---|---:|
| Web service | Render Starter 512 MB | $7 |
| PostgreSQL | Basic-256MB | $6 |
| Storage DB | 10 GB × $0.30 | $3 |
| Object storage | 10 GB S3 Standard | $0.23 |
| Access proxy | Cloudflare Access free tier | $0 |
| CI/backup runner | GitHub Actions dalam kuota | $0 |
| Monitoring | free tier | $0 |
| **Total** | | **± $16–$17/bulan** |

### Skenario production-like

| Komponen | Asumsi | Estimasi |
|---|---|---:|
| Web service | Render Standard 2 GB | $25 |
| PostgreSQL | Basic 1 GB | $19 |
| Storage DB | 20 GB × $0.30 | $6 |
| Object storage | 50 GB S3 Standard | $1.15 |
| Domain | amortisasi domain | ± $1 |
| CI/backup runner | dalam kuota / sedikit overage | $0–$2 |
| **Total** | | **± $52–$55/bulan** |

Biaya di luar estimasi: bandwidth overage, build minutes, request S3, PITR/HA, dan pajak. Staging tidak memerlukan Redis, worker, email, atau object storage evidence terpisah.

## E. Langkah Konfigurasi

1. **Buat project staging terpisah.** Jangan gunakan project/workspace produksi.
2. **Provision PostgreSQL staging.** Gunakan PostgreSQL 16 (atau major yang sama dengan produksi), private network, TLS, automated backup/PITR bila tersedia. Catat connection string internal dan eksternal.
3. **Buat bucket backup staging.** Aktifkan versioning, enkripsi default (SSE-S3/SSE-KMS), Block Public Access, dan lifecycle 90 hari. Buat IAM user staging dengan izin minimal `PutObject`, `GetObject`, `ListBucket` pada prefix staging.
4. **Generate secret staging** dengan password manager/secret generator:
   - bootstrap password 20+ karakter,
   - backup encryption key 32 byte,
   - TikTok token encryption key 32 byte (jika TikTok aktif),
   - database password,
   - AWS access key staging.
5. **Isi environment web service** mengikuti `staging/staging.env.example`. Set `NODE_ENV=production`, `ORDERGUARD_TRUST_PROXY=1`, dan `ORDERGUARD_ALLOWED_ORIGINS=https://<staging-host>`.
6. **Konfigurasi akses staging.** Pasang Cloudflare Access/Zero Trust atau IP allowlist. Jangan biarkan staging dapat diakses publik tanpa autentikasi tambahan.
7. **Konfigurasi backup runner.** Gunakan Docker cron di private network (disarankan) atau GitHub Actions scheduled. Jalankan `npm run db:backup:check`, lalu backup pertama, lalu verifikasi objek dan checksum di bucket.
8. **Uji restore ke database staging terpisah.** Jangan restore ke database staging utama sebelum drill berhasil.
9. **Deploy manual** dari commit yang CI-nya hijau. Catat SHA, deploy ID, dan waktu.
10. **Bootstrap admin pertama** hanya pada database kosong. Setelah login berhasil, hapus `ORDERGUARD_BOOTSTRAP_PASSWORD` dari environment.
11. **Buat tenant/user staging sintetis** untuk pengujian lintas tenant. Jangan memakai akun produksi.
12. **Jalankan smoke test dan checklist** di `staging/VERIFICATION.md`. Catat bukti pada commit/deploy yang diuji.
13. **Aktifkan monitoring** health check dan alert backup gagal.

Detail deployment: `staging/DEPLOYMENT.md`. Rollback: `staging/ROLLBACK.md`. Backup runner: `staging/BACKUP-RUNNER.md`.

## F. Risiko Keamanan

| Risiko | Dampak | Mitigasi wajib |
|---|---|---|
| Staging terbuka publik | Enumerasi, login brute force, kebocoran data uji | Cloudflare Access/IP allowlist, rate limit, password kuat |
| Kredensial produksi dipakai di staging | Akses tidak sah ke produksi | Secret staging terpisah, larangan copy secret produksi |
| Database staging tanpa TLS | Intersepsi kredensial/data | `sslmode=require`, private network |
| Backup tidak benar-benar off-site | Kehilangan backup saat insiden | Bucket terpisah, versioning, uji restore |
| Backup plaintext | Kebocoran data | Encryption key wajib, `ALLOW_PLAINTEXT` tidak diatur |
| Key backup/token sama dengan produksi | Blast radius | Generate key baru khusus staging |
| Akun demo aktif | Akses default | `NODE_ENV=production` menolak akun demo; bootstrap lalu hapus secret |
| `ORDERGUARD_ALLOWED_ORIGINS` salah/wildcard | CSRF/origin bypass | Origin eksak, tanpa wildcard, uji 403 |
| Proxy trust salah | IP/rate limit/origin salah | `ORDERGUARD_TRUST_PROXY=1` hanya di belakang proxy tepercaya |
| Data produksi masuk staging | Pelanggaran privasi | Hanya data sintetis; scrub sebelum upload |
| TikTok app produksi dipakai | Posting/akses toko nyata | App staging terpisah atau nonaktifkan |
| Log membocorkan token/password | Kebocoran | Masking, review log, jangan log body sensitif |
| Backup runner punya akses DB publik | Permukaan serangan | Private network/Docker cron, TLS, kredensial terbatas |
| Service worker cache lama | UI versi salah | Uji transisi cache v9→v10, bump versi saat deploy |
| Tidak ada alert backup gagal | RPO tidak terpenuhi | Monitoring/alert runner dan bucket |
| Migrasi startup gagal | Downtime | Backup pra-deploy, uji di staging, rollback plan |
| `NODE_ENV=production` di staging | Label `/api/config` menunjukkan production | Dokumentasikan; staging dibedakan oleh host/DB/key, bukan label |

## G. Checklist Verifikasi

Checklist lengkap ada di `staging/VERIFICATION.md` dan `staging/SECURITY-CHECKLIST.md`. Ringkasan gerbang sebelum staging dinyatakan siap:

- [ ] Tidak ada kredensial produksi di environment staging.
- [ ] `main` tidak berubah; tidak ada merge/deploy produksi.
- [ ] Database staging terpisah, TLS, private network.
- [ ] Bucket backup terpisah, versioning, enkripsi, lifecycle.
- [ ] Backup preflight lulus dan backup pertama terverifikasi.
- [ ] Restore drill ke database staging terpisah lulus.
- [ ] `NODE_ENV=production`, cookie `Secure`, HSTS, CSP aktif.
- [ ] Bootstrap admin dibuat, secret bootstrap dihapus.
- [ ] Tidak ada akun demo aktif.
- [ ] Login, cross-tenant, scan, handover, evidence, quarantine, reports berfungsi.
- [ ] E2E 8/8 dan load test 0 error pada commit yang diuji.
- [ ] Rollback drill berhasil.
- [ ] Monitoring dan alert backup aktif.

**Semua item di atas berstatus belum dijalankan pada staging. Dokumen ini disiapkan untuk persetujuan sebelum provisioning/deployment.**
