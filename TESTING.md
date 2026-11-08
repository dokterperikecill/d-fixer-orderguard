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
