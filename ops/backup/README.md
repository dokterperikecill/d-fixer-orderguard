# Backup Runner (Docker)

Cron native Render (runtime Node) tidak dijamin memiliki `pg_dump`, `aws`, atau `rclone`.
Karena itu backup produksi/staging harus dijalankan dari image ini, bukan dari runtime Node biasa.

## Build

```sh
docker build -f ops/backup/Dockerfile -t orderguard-backup:latest .
```

Image berisi:

- Node.js 24
- `postgresql-client-16` (dari PGDG)
- AWS CLI + rclone
- `tini` sebagai init

## Menjalankan manual

```sh
docker run --rm \
  --env-file /etc/orderguard/backup.env \
  -v /var/backups/orderguard:/tmp/orderguard-backups \
  orderguard-backup:latest
```

Pastikan direktori host dapat ditulis UID `10001` (user `orderguard` di image):

```sh
sudo install -d -o 10001 -g root -m 700 /var/backups/orderguard
```

Isi `backup.env` (mode `600`):

```sh
DATABASE_URL=postgresql://user:pass@host:5432/orderguard?sslmode=require
ORDERGUARD_BACKUP_ENCRYPTION_KEY=<64 hex / base64 32 byte>
ORDERGUARD_BACKUP_DIR=/tmp/orderguard-backups
ORDERGUARD_BACKUP_KEEP=30
ORDERGUARD_BACKUP_OFFSITE_S3_URI=s3://bucket/prefix
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=ap-southeast-1
ORDERGUARD_ALERT_WEBHOOK_URL=https://hooks.slack.com/services/...
ORDERGUARD_ALERT_WEBHOOK_FORMAT=slack
```

Perintah default image menjalankan **preflight** lalu **backup** dan akan mengirim alert
jika salah satu gagal.

## Jadwal

### Opsi A — systemd timer (VPS)

Gunakan `orderguard-backup.service` dan `orderguard-backup.timer` di direktori ini.
Salin ke `/etc/systemd/system/`, sesuaikan path/env, lalu:

```sh
systemctl daemon-reload
systemctl enable --now orderguard-backup.timer
systemctl list-timers orderguard-backup.timer
```

### Opsi B — Render Docker cron

`render.yaml` mendefinisikan cron `runtime: docker` dengan `dockerfilePath: ./ops/backup/Dockerfile`.
Verifikasi pada staging bahwa Render dapat membangun image dan cron berjalan (lihat
`staging/VERIFICATION.md`).

### Opsi C — GitHub Actions scheduled

Gunakan `.github/workflows/ops-healthcheck.yml` sebagai pola; jangan simpan kredensial
produksi di workflow staging.

## Bukti yang harus disimpan

- Log preflight dan backup sukses.
- Nama file `.dump.enc`, `.meta.json`, `.sha256`.
- Hasil `npm run db:drill` (restore drill).
- Waktu eksekusi dan commit yang berjalan.
