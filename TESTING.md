# Panduan Pengujian

## Backend dan unit test

```sh
TEST_DATABASE_URL="postgresql://user:password@host:5432/orderguard_test" npm test
```

Mencakup Wave 1 security, Wave 2 data integrity, backup crypto, TikTok, dan evidence validation.

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

## Integrity audit

```sh
DATABASE_URL="postgresql://user:password@host:5432/orderguard" npm run db:integrity:audit
DATABASE_URL="postgresql://user:password@host:5432/orderguard" npm run db:integrity:reconcile
```

Jangan menjalankan `--apply` tanpa review laporan dan persetujuan.
