# Backup Runner Staging

**Status: desain, belum dijalankan.** Tujuan: backup logis terenkripsi ke object storage yang benar-benar terpisah dari filesystem web service.

## Mengapa runner terpisah?

`render.yaml` produksi memakai Render cron native dengan `npm run db:backup`. Namun script backup membutuhkan:

- `pg_dump` dan `pg_restore` versi yang cocok,
- `aws` CLI atau `rclone` untuk off-site,
- akses ke database dan bucket.

Runtime Node native belum tentu menyediakan CLI tersebut. Jangan mengandalkan cron native tanpa memverifikasi image/lingkungannya.

## Opsi A — Docker cron di private network (disarankan)

Buat cron service Docker yang berisi:

- Node.js 24,
- `postgresql-client-16`,
- `awscli` atau `rclone`,
- kode aplikasi dan `node_modules` hasil `npm ci`.

Keuntungan:

- Database dapat diakses lewat private network.
- Tidak perlu membuka database ke internet.
- Kontrol penuh atas versi `pg_dump`.

Konsep `Dockerfile`:

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-16 awscli ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
CMD ["npm", "run", "db:backup"]
```

Jadwalkan harian, misalnya 02:00 WIB. Set environment runner:

```sh
DATABASE_URL=postgresql://...?...sslmode=require
ORDERGUARD_BACKUP_DIR=/tmp/orderguard-backups
ORDERGUARD_BACKUP_ENCRYPTION_KEY=<staging-key>
ORDERGUARD_BACKUP_OFFSITE_S3_URI=s3://<staging-bucket>/orderguard/
ORDERGUARD_BACKUP_KEEP=30
AWS_ACCESS_KEY_ID=<staging-key-id>
AWS_SECRET_ACCESS_KEY=<staging-secret>
AWS_REGION=ap-southeast-1
```

Sebelum jadwal pertama, jalankan manual:

```sh
npm run db:backup:check
npm run db:backup
```

## Opsi B — GitHub Actions scheduled

Cocok untuk staging awal, tetapi database harus dapat diakses dari runner GitHub (external URL + TLS). Batasi kredensial dan pertimbangkan IP allowlist.

Contoh workflow yang **belum diaktifkan** (simpan di luar `.github/workflows/` sampai disetujui):

```yaml
name: Staging Backup

on:
  schedule:
    - cron: "0 19 * * *" # 02:00 WIB
  workflow_dispatch:

permissions:
  contents: read

jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - name: Install PostgreSQL client and AWS CLI
        run: |
          sudo apt-get update
          sudo apt-get install -y postgresql-client-16 awscli
      - run: npm ci
      - name: Preflight
        env:
          DATABASE_URL: ${{ secrets.STAGING_DATABASE_URL }}
          ORDERGUARD_BACKUP_ENCRYPTION_KEY: ${{ secrets.STAGING_BACKUP_ENCRYPTION_KEY }}
          ORDERGUARD_BACKUP_DIR: /tmp/orderguard-backups
          ORDERGUARD_BACKUP_OFFSITE_S3_URI: ${{ secrets.STAGING_BACKUP_S3_URI }}
          AWS_ACCESS_KEY_ID: ${{ secrets.STAGING_AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.STAGING_AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: ${{ secrets.STAGING_AWS_REGION }}
        run: npm run db:backup:check
      - name: Encrypted backup
        env:
          DATABASE_URL: ${{ secrets.STAGING_DATABASE_URL }}
          ORDERGUARD_BACKUP_ENCRYPTION_KEY: ${{ secrets.STAGING_BACKUP_ENCRYPTION_KEY }}
          ORDERGUARD_BACKUP_DIR: /tmp/orderguard-backups
          ORDERGUARD_BACKUP_OFFSITE_S3_URI: ${{ secrets.STAGING_BACKUP_S3_URI }}
          ORDERGUARD_BACKUP_KEEP: "30"
          AWS_ACCESS_KEY_ID: ${{ secrets.STAGING_AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.STAGING_AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: ${{ secrets.STAGING_AWS_REGION }}
        run: npm run db:backup
      - name: Verify object exists
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.STAGING_AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.STAGING_AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: ${{ secrets.STAGING_AWS_REGION }}
          STAGING_BACKUP_S3_URI: ${{ secrets.STAGING_BACKUP_S3_URI }}
        run: aws s3 ls "$STAGING_BACKUP_S3_URI/" | tail -n 3
```

Catatan:

- `actions/checkout` harus di pin ke commit/branch staging yang disetujui.
- Jangan memakai secret produksi.
- Scheduled workflow bisa tertunda; untuk RPO ketat gunakan cron container.
- Jika database tidak boleh terbuka ke internet, gunakan Opsi A.

## Bucket dan IAM

- Bucket terpisah: `dfixer-orderguard-staging-backups`.
- Prefix: `orderguard/`.
- Versioning: aktif.
- Default encryption: SSE-S3 atau SSE-KMS.
- Block Public Access: aktif.
- Lifecycle: misalnya transisi ke Standard-IA setelah 30 hari, expire setelah 90 hari (sesuaikan kebijakan).
- IAM:
  - `s3:PutObject` pada `arn:aws:s3:::bucket/orderguard/*`
  - `s3:GetObject` pada prefix yang sama (untuk restore)
  - `s3:ListBucket` pada bucket dengan prefix condition
  - jangan beri akses ke bucket produksi.

## Verifikasi backup

Setelah backup:

```sh
aws s3 ls "s3://<staging-bucket>/orderguard/" | tail -n 5
```

Pastikan ada:

- `orderguard-YYYYMMDDTHHMMSSZ.dump.enc`
- `orderguard-YYYYMMDDTHHMMSSZ.dump.enc.meta.json`
- `orderguard-YYYYMMDDTHHMMSSZ.dump.enc.sha256`

Uji restore ke database staging terpisah:

```sh
DATABASE_URL="$STAGING_RESTORE_DATABASE_URL" \
ORDERGUARD_CONFIRM_RESTORE="<nama-db-restore>" \
ORDERGUARD_BACKUP_ENCRYPTION_KEY="$ORDERGUARD_BACKUP_ENCRYPTION_KEY" \
ORDERGUARD_BACKUP_DIR=/tmp/orderguard-restore \
npm run db:restore -- /tmp/orderguard-restore/orderguard-....dump.enc
```

## Alert

- Alert jika preflight/backup exit non-zero.
- Alert jika tidak ada objek baru dalam 26 jam.
- Alert jika bucket versioning/encryption berubah.
- Simpan log runner minimal 30 hari.
