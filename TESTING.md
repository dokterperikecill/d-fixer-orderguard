# Panduan Pengujian

> Jalankan `npm test`, `npm run e2e`, dan `npm run load` secara berurutan. Ketiganya memakai database test dan resource lokal yang sama; eksekusi paralel dapat menyebabkan kegagalan karena contention, bukan karena defect aplikasi.

## Backend dan unit test

```sh
TEST_DATABASE_URL="postgresql://user:password@host:5432/orderguard_test" npm test
```

Mencakup Wave 1 security, Wave 2 data integrity, backup crypto, off-site transport, key rotation, backup preflight, constraint validation, TikTok, dan evidence validation.

## Browser E2E (Playwright)

Prasyarat:

```sh
npx playwright install chromium
```

Jalankan:

```sh
TEST_DATABASE_URL="postgresql://user:password@host:5432/orderguard_test" npm run e2e
```

E2E menggunakan schema PostgreSQL terpisah `orderguard_e2e`, user sintetis, dan data demo test-only. Server E2E dijalankan oleh Playwright melalui `scripts/e2e-server.js`; tidak menggunakan server produksi.

Hasil:

- HTML report: `playwright-report/index.html`
- Screenshot/video/trace kegagalan: `test-results/`
- Jangan commit direktori artefak tersebut.

## Load test

```sh
TEST_DATABASE_URL="postgresql://user:password@host:5432/orderguard_test" npm run load
```

Load test membuat schema sementara, menjalankan server test, lalu menguji:

- `GET /api/health`
- `GET /api/state`
- concurrent manifest creation
- concurrent package scanning
- concurrent 25 scans across 5 manifests
- concurrent handover
- memory RSS server dan error rate

Hasil ditampilkan sebagai JSON; tidak dijalankan terhadap produksi.

## Runtime dan operasional

`backend.test.js`, `tiktok-shop.test.js`, `evidence.test.js`, dan `ops.test.js` mencakup readiness, metrics terproteksi token, serta graceful shutdown (`SIGTERM` keluar `0` dan listener tertutup).

```sh
TEST_DATABASE_URL="postgresql://user:password@host:5432/orderguard_test" npm test
```

## Staging verification

Smoke keamanan + fungsional dasar (health, readiness, header, cookie, CSRF, origin, rate limit, logout):

```sh
STAGING_BASE_URL="https://staging.example.com" \
STAGING_USERNAME="staging-verifier" \
STAGING_PASSWORD="<rahasia>" \
STAGING_RATE_LIMIT_USERNAME="rate-limit-probe" \
npm run staging:smoke
```

Browser E2E ke staging nyata (tanpa `webServer`, tanpa seeding demo):

```sh
STAGING_BASE_URL="https://staging.example.com" \
STAGING_USERNAME="staging-verifier" \
STAGING_PASSWORD="<rahasia>" \
STAGING_TENANT_NAME="D'Fixer Store" \
npm run e2e:staging
```

Load read-only ke staging (tidak menulis data):

```sh
LOAD_TEST_BASE_URL="https://staging.example.com" \
LOAD_TEST_USERNAME="staging-verifier" \
LOAD_TEST_PASSWORD="<rahasia>" \
npm run load:staging
```

`STAGING_ALLOW_HTTP=1` hanya untuk rehearsal lokal. Jangan gunakan `STAGING_INSECURE_TLS=1` pada staging sungguhan.

## Restore drill

```sh
DRILL_SOURCE_DATABASE_URL="postgresql://.../orderguard_staging" \
DRILL_TARGET_DATABASE_URL="postgresql://.../orderguard_staging_restore" \
ORDERGUARD_BACKUP_ENCRYPTION_KEY="<key>" \
DRILL_BACKUP_DIR=/tmp/orderguard-drill \
DRILL_REPORT_PATH=/tmp/orderguard-drill/report.json \
npm run db:drill
```

Drill lulus hanya jika restore ke database terpisah berhasil, jumlah baris cocok, key salah ditolak, dan ciphertext termodifikasi ditolak.

## Backup/restore

```sh
ORDERGUARD_BACKUP_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
ORDERGUARD_BACKUP_DIR=/tmp/orderguard-backups \
npm run db:backup

DATABASE_URL="postgresql://user:password@host:5432/orderguard_restore_test" \
ORDERGUARD_CONFIRM_RESTORE=orderguard_restore_test \
ORDERGUARD_BACKUP_ENCRYPTION_KEY="<key>" \
npm run db:restore -- /tmp/orderguard-backups/orderguard-....dump.enc
```

Restore harus diuji ke database terpisah dan diverifikasi tabel/data setelah restore.

## Backup preflight dan key rotation

```sh
ORDERGUARD_BACKUP_ENCRYPTION_KEY="<key>" npm run db:backup:check

ORDERGUARD_BACKUP_ENCRYPTION_KEY="<key-lama>" \
ORDERGUARD_BACKUP_NEW_ENCRYPTION_KEY="<key-baru>" \
ORDERGUARD_BACKUP_DIR=/tmp/orderguard-backups npm run db:backup:rotate-keys
```

Dry-run adalah default. Untuk menerapkan:

```sh
ORDERGUARD_BACKUP_ENCRYPTION_KEY="<key-lama>" \
ORDERGUARD_BACKUP_NEW_ENCRYPTION_KEY="<key-baru>" \
ORDERGUARD_BACKUP_DIR=/tmp/orderguard-backups \
npm run db:backup:rotate-keys -- --apply --confirm /tmp/orderguard-backups
```

## Integrity audit dan constraint validation

```sh
DATABASE_URL="postgresql://user:password@host:5432/orderguard" npm run db:integrity:audit
DATABASE_URL="postgresql://user:password@host:5432/orderguard" npm run db:integrity:reconcile
DATABASE_URL="postgresql://user:password@host:5432/orderguard" npm run db:constraints:validate
```

Untuk menerapkan validasi constraint:

```sh
DATABASE_URL="postgresql://user:password@host:5432/orderguard" npm run db:constraints:validate -- --apply --confirm orderguard
```

Jangan menjalankan `--apply` tanpa review laporan dan persetujuan. Validasi constraint diblokir bila masih ada orphan atau referensi lintas tenant.
