# Operasi OrderGuard

## PWA dan Aplikasi Desktop

Aplikasi web dapat dipasang di Android sebagai PWA setelah di-deploy melalui HTTPS. Manifest dan service worker disediakan oleh server; API `/api/` sengaja tidak disimpan ke cache, sehingga login dan sinkronisasi data tetap memerlukan koneksi ke server.

Cache PWA hanya menyimpan shell aplikasi. Setelah mengubah `app.js`, `styles.css`, atau aset shell lain, naikkan versi `CACHE_NAME` di `service-worker.js` agar perangkat mengambil aset rilis terbaru.

### Deploy ke Render

1. Push proyek ke repository GitHub, lalu di Render pilih **New → Blueprint** dan hubungkan repository tersebut.
2. Sediakan PostgreSQL terkelola dan isi `DATABASE_URL` di Render sebagai secret. Blueprint tidak membuat database berbayar secara otomatis.
3. Isi `ORDERGUARD_BOOTSTRAP_USERNAME`, `ORDERGUARD_BOOTSTRAP_NAME`, dan `ORDERGUARD_BOOTSTRAP_PASSWORD` sebagai environment variable rahasia di Render. Password harus minimal 12 karakter. Jangan simpan rahasia di repository atau kirim melalui chat.
4. Tunggu health check `/api/health` berhasil, lalu gunakan URL HTTPS `*.onrender.com` yang diberikan Render.

URL Render sudah cukup untuk uji coba dan PWA; domain pribadi bisa ditambahkan kemudian. Gunakan URL akhir yang sama saat membuat installer desktop dan konfigurasi TWA Android.

Untuk installer Windows, atur URL domain HTTPS produksi saat menjalankan perintah build:

```sh
ORDERGUARD_APP_URL=https://app.domainanda.com npm run desktop:dist
```

Di Windows PowerShell:

```powershell
$env:ORDERGUARD_APP_URL = "https://app.domainanda.com"
npm run desktop:dist
```

Installer NSIS akan dibuat di `release/desktop/`. Perintah ini perlu dijalankan di Windows untuk build Windows yang paling andal. Untuk pengembangan desktop, set `ORDERGUARD_APP_URL` ke URL HTTPS server, lalu jalankan `npm run desktop:dev`.

APK Android melalui Trusted Web Activity (TWA) belum dapat dibuat sebelum domain produksi tersedia. APK memerlukan PWA yang sudah ter-deploy, konfigurasi verifikasi domain (`/.well-known/assetlinks.json`), Android SDK, dan kunci penandatanganan Android. Domain publik juga diperlukan untuk menyiapkan serta menguji file verifikasi tersebut.

## Inisialisasi Production

Database PostgreSQL baru tidak membuat akun demo. Tentukan `DATABASE_URL` dan bootstrap Platform Admin melalui environment saat menjalankan aplikasi:

```sh
NODE_ENV=production \
DATABASE_URL="postgresql://user:password@host:5432/orderguard" \
ORDERGUARD_BOOTSTRAP_USERNAME=platform-owner \
ORDERGUARD_BOOTSTRAP_NAME="Platform Owner" \
ORDERGUARD_BOOTSTRAP_PASSWORD="GANTI-DENGAN-RAHASIA-KUAT" \
npm start
```

Simpan password melalui secret manager, bukan file yang masuk Git atau log shell. Password bootstrap hanya digunakan jika tabel pengguna kosong. Untuk migrasi database demo lama, nonaktifkan/ganti seluruh akun demo dan passwordnya sebelum membuka layanan ke jaringan.

Production harus menggunakan HTTPS. Cookie sesi hanya diberi flag `Secure` saat `NODE_ENV=production`.

## Keamanan Autentikasi dan CSRF

OrderGuard memakai cookie sesi dan CSRF token yang terikat ke sesi.

- Setiap login atau `GET /api/session` mengembalikan `csrfToken`.
- Request `POST`, `PATCH`, dan `DELETE` wajib mengirim header `X-CSRF-Token`.
- Frontend resmi sudah mengirim header tersebut secara otomatis.
- API client non-browser harus mengambil token dari login/session lalu mengirim header yang sama.
- Request tanpa token, token salah, atau token dari sesi lain ditolak `403` dengan kode `CSRF_INVALID`.

Konfigurasi origin produksi:

```sh
ORDERGUARD_ALLOWED_ORIGINS="https://app.domainanda.com"
ORDERGUARD_TRUST_PROXY=1
```

- `ORDERGUARD_ALLOWED_ORIGINS` berisi origin persis, dipisahkan koma. Wildcard `*` tidak diizinkan dan akan menggagalkan startup.
- Same-origin selalu diizinkan.
- Di Render/reverse proxy, `ORDERGUARD_TRUST_PROXY=1` diperlukan agar Origin dan IP client dibaca benar.
- Origin/Referer tidak tepercaya ditolak `403` dengan kode `ORIGIN_REJECTED`.

Rate limit login (opsional; default ditampilkan):

```sh
ORDERGUARD_LOGIN_WINDOW_MINUTES=15
ORDERGUARD_LOGIN_MAX_ATTEMPTS=5
ORDERGUARD_LOGIN_MAX_IP_ATTEMPTS=20
ORDERGUARD_SESSION_HOURS=8
```

Percobaan login berulang menghasilkan `429` dengan `Retry-After`. Batas berlaku per jendela waktu; akun tidak dikunci permanen.

Audit autentikasi disimpan di tabel `auth_audit` (login sukses/gagal/blocked, logout, session expired/invalid, perubahan kredensial, pencabutan sesi). Password, session token, CSRF token, dan secret tidak disimpan. Lihat `SECURITY.md` untuk detail dan contoh query.

Password user baru dan perubahan password minimal 10 karakter; password bootstrap Platform Admin minimal 12 karakter.

## PostgreSQL Lokal

Docker Compose menyediakan PostgreSQL persisten untuk pengembangan:

```sh
export POSTGRES_PASSWORD='password-lokal-yang-kuat'
docker compose up -d postgres
export DATABASE_URL="postgresql://orderguard:${POSTGRES_PASSWORD}@localhost:5432/orderguard"
npm start
```

Jalankan tes backend terhadap database uji PostgreSQL khusus:

```sh
createdb -h localhost -U orderguard orderguard_test
TEST_DATABASE_URL="postgresql://orderguard:${POSTGRES_PASSWORD}@localhost:5432/orderguard_test" npm test
```

Tes membuat dan menghapus schema berawalan `orderguard_test_`; jangan arahkan `TEST_DATABASE_URL` ke database produksi.

## Integrasi TikTok Shop

Integrasi tersedia untuk aplikasi ISV yang sudah disetujui di TikTok Shop Partner Center. Sinkronisasi bersifat read-only: OrderGuard mengambil pesanan dan retur dari toko yang sudah diotorisasi, lalu pengguna harus meninjau hasil sebelum membuat manifest.

Sinkronisasi mencari pesanan yang diperbarui dalam 30 hari terakhir. Pesanan tanpa resi dan pesanan berstatus `CANCELLED` dilewati saat pembuatan manifest. Untuk pesanan yang sudah pernah diimpor, perubahan status akan dicatat sebagai event pembatalan/retur otomatis:

- `CANCELLED` → `CANCELLED_BEFORE_HANDOVER` atau `CANCELLATION_AFTER_HANDOVER`
- status retur dalam perjalanan → `RETURN_IN_TRANSIT`
- retur ditolak/dibatalkan → event `CANCELLATION_REJECTED`

Penerimaan fisik retur tetap harus dikonfirmasi manual dengan foto oleh Store Admin atau Handover Staff. Sinkronisasi tidak pernah menandai `RETURN_RECEIVED` tanpa bukti foto.

Endpoint retur yang dipakai saat ini adalah `POST /return_refund/202309/returns/search`. Path dapat dioverride melalui `TIKTOK_RETURNS_PATH` jika toko hanya mengaktifkan versi API retur yang lebih baru. Verifikasi path dan scope di Partner Center sebelum produksi. Kegagalan endpoint retur tidak menggagalkan sinkronisasi pesanan; antarmuka akan menampilkan peringatan.

Scope yang dibutuhkan: baca daftar pesanan dan baca retur/refund (Return & Refund Basic / `seller.return_refund.basic`).

1. Daftarkan OAuth redirect URL aplikasi di Partner Center dengan URL HTTPS persis berikut: `https://<domain-orderguard>/api/tiktok/callback`. Pastikan aplikasi disetujui untuk authorization toko dan akses baca daftar pesanan.
2. Atur environment variable berikut di secret manager/deployment platform:
   - `TIKTOK_APP_KEY`
   - `TIKTOK_APP_SECRET` (rahasia)
   - `TIKTOK_REDIRECT_URI` (URL callback yang sama persis)
   - `ORDERGUARD_TOKEN_ENCRYPTION_KEY` (kunci 32-byte dalam hex 64 karakter atau base64)
3. Buat kunci enkripsi dengan `openssl rand -hex 32`, lalu simpan sebagai secret. Gunakan kunci yang sama setelah restart dan saat restore database; menggantinya membuat token tersimpan tidak dapat dibaca.
4. Di halaman **Impor data**, Store Admin atau Platform Admin memilih **Hubungkan toko**, menyelesaikan otorisasi TikTok Shop, lalu memilih toko dan menekan **Ambil pesanan dengan resi**. Hasil tetap melewati validasi dan konfirmasi pembuatan manifest.

Access/refresh token disimpan terenkripsi di PostgreSQL dan tidak dikirim ke browser. Database serta kunci enkripsinya harus dicadangkan dan dipulihkan bersama. Jangan memasukkan kredensial aplikasi atau token ke repository, log, atau chat. Periksa Partner Center untuk endpoint, scope, dan persyaratan review ISV terbaru sebelum mengaktifkan integrasi produksi.

## Migrasi SQLite ke PostgreSQL

1. Buat PostgreSQL kosong dan atur `DATABASE_URL` ke database tujuan. Jangan jalankan beberapa versi aplikasi yang menulis data selama migrasi.
2. Hentikan aplikasi yang menggunakan SQLite dan salin file database sebagai cadangan sebelum migrasi:

   ```sh
   cp data/orderguard.db data/orderguard-before-postgres.db
   ```

   Jika database SQLite berada di lokasi lain, gunakan path yang sesuai. Simpan salinan di lokasi aman.
3. Jalankan migrasi satu kali dengan dependensi proyek terpasang:

   ```sh
   DATABASE_URL="postgresql://user:password@host:5432/orderguard" \
     npm run db:migrate -- /path/ke/orderguard.db
   ```

   Migrasi memindahkan tabel yang dikenali dalam satu transaksi dan menolak database PostgreSQL yang sudah berisi data. File SQLite sumber tidak diubah atau dihapus.
4. Atur `DATABASE_URL` pada service aplikasi, lalu jalankan `npm start`. Server membuat skema yang belum ada dan memeriksa koneksi PostgreSQL pada health check.
5. Jika data hasil migrasi memiliki akun demo aktif (`admin`, `rani`, `handover`, atau `maya`), nonaktifkan/migrasikan akun tersebut sebelum startup dengan `NODE_ENV=production`; aplikasi sengaja menolak akun demo aktif. Setelah verifikasi akun, tenant, manifest, dan riwayat berhasil, simpan file SQLite sebagai backup offline. Jangan jalankan aplikasi produksi pada database sumber dan tujuan secara paralel.

Pastikan kredensial pada URL database disimpan sebagai secret. Jangan mengetik URL berisi password ke shell bersama atau memasukkannya ke log.

## Pembatalan dan Retur

Pembatalan pembeli dan retur dicatat sebagai event append-only pada state tenant. Retur memakai nomor resi yang sama; tidak ada nomor resi retur terpisah.

- Store Admin dan Platform Admin dapat mencatat pembatalan sebelum pickup, pembatalan setelah pickup, awal retur, penolakan pembatalan, dan penerimaan retur.
- Handover Staff hanya dapat menandai retur diterima.
- Resi harus sudah ada pada manifest tenant. Resi di luar manifest ditolak.
- Foto bukti wajib saat menandai retur diterima.
- Pembatalan yang ditolak marketplace mengembalikan status paket ke status normal sebelumnya.
- Angka “diterima kurir” dihitung dari riwayat handover, sehingga tetap 100 meskipun 3 paket dibatalkan setelah pickup.

Endpoint yang dipakai:

```text
POST /api/order-events
```

Jenis event: `CANCELLED_BEFORE_HANDOVER`, `CANCELLATION_AFTER_HANDOVER`, `RETURN_IN_TRANSIT`, `RETURN_RECEIVED`, dan `CANCELLATION_REJECTED`.

## Backup

Jalankan backup konsisten saat server hidup:

```sh
npm run db:backup
```

Jalankan `pg_dump` dan `pg_restore` dari PostgreSQL client tools yang tersedia. Secara default file custom-format disimpan di `data/backups/` dan retensi menyimpan 30 backup terakhir. Atur `ORDERGUARD_BACKUP_DIR` atau `ORDERGUARD_BACKUP_KEEP` bila lokasi atau retensinya berbeda. Backup berisi data operasional dan wajib diperlakukan sebagai data sensitif. Pastikan user database memiliki izin backup dan restore.

Setiap backup menghasilkan:

- `orderguard-YYYYMMDDTHHMMSSZ.dump` — custom-format PostgreSQL.
- `orderguard-YYYYMMDDTHHMMSSZ.dump.sha256` — checksum integritas.

Script memvalidasi arsip dengan `pg_restore --list` dan menulis checksum SHA-256. Simpan file `.dump` dan `.sha256` bersama-sama. Backup tidak dienkripsi oleh script; gunakan enkripsi disk/secret manager bila diperlukan.

## Restore

Restore adalah tindakan destruktif pada database target. Script membutuhkan konfirmasi eksplisit berupa nama database target:

```sh
DATABASE_URL="postgresql://user:password@host:5432/orderguard" \
ORDERGUARD_CONFIRM_RESTORE="orderguard" \
npm run db:restore -- data/backups/orderguard-YYYYMMDDTHHMMSSZ.dump
```

Script akan:

1. Memeriksa checksum `.sha256` bila tersedia.
2. Memvalidasi arsip dengan `pg_restore --list`.
3. Membuat backup keselamatan `orderguard-pre-restore-*.dump`.
4. Menjalankan restore atomik (`--single-transaction --clean --if-exists`) ke database target.
5. Memverifikasi tabel `tenants` setelah restore.

**Jangan arahkan `DATABASE_URL` restore ke database produksi tanpa persetujuan dan backup terbaru.** Uji restore pada database terpisah terlebih dahulu, lalu jalankan health check/test setelah restore. Script ini tidak menjadwalkan backup otomatis; jadwalkan melalui cron/Render cron job dan simpan salinan di media terpisah.

## Inisialisasi Tenant Baru

Tenant baru selalu dimulai dengan state operasional kosong. Data demo tidak lagi dibuat otomatis untuk tenant baru. Data lama pada tenant yang sudah ada tidak dihapus.

Untuk pengembangan/test internal, data demo hanya dapat diaktifkan eksplisit melalui environment test:

```sh
NODE_ENV=test ORDERGUARD_TEST_SEED_DEMO=1 npm start
```

Jangan gunakan opsi tersebut pada production.

## Integritas Data

- Setiap manifest ID dicatat di `tenant_manifest_ids` dan divalidasi unik per tenant. Pembuatan manifest berjalan di dalam transaksi tenant state yang sama, sehingga dua request paralel tidak dapat menghasilkan ID duplikat.
- Manifest berstatus `CLOSED`, `CANCELLED`, atau `CONFIRMED` tidak dapat diubah melalui scan atau handover. Penutupan/pembatalan resmi tetap melalui workflow Store Admin yang tercatat.
- Setiap scan wajib memiliki catatan audit yang sesuai; setiap sesi handover wajib memiliki audit `Serah terima <id> dikonfirmasi: ...`.
- Bukti handover bersifat append-only; evidence pada sesi lama tidak dapat diubah.
- Payload state yang tidak valid tidak diganti dengan state demo. Payload asli dipertahankan di `state_quarantine` untuk investigasi/recovery manual, dan API mengembalikan `503 STATE_CORRUPTED`.
- Foreign key ditambahkan secara additive dengan `NOT VALID`: constraint berlaku untuk data baru tanpa menggagalkan startup karena data lama. Setelah audit data lama, constraint dapat divalidasi manual:

  ```sql
  ALTER TABLE users VALIDATE CONSTRAINT users_tenant_fk;
  ```

- Index tambahan tersedia untuk session, audit, user tenant, manifest registry, dan quarantine.

## Audit Integritas & Rekonsiliasi

Audit bersifat read-only dan tidak menghapus data:

```sh
DATABASE_URL="postgresql://user:password@host:5432/orderguard" npm run db:integrity:audit
```

Audit memeriksa foreign key `NOT VALID`, orphan record, dan manifest ID duplikat. Rekonsiliasi default dry-run:

```sh
DATABASE_URL="..." npm run db:integrity:reconcile
```

Untuk menerapkan pemindahan orphan ke `integrity_orphans` dan validasi FK:

```sh
DATABASE_URL="..." npm run db:integrity:reconcile -- --apply --confirm orderguard
```

- Tanpa `--apply --confirm <nama-database>`, tidak ada perubahan.
- Orphan disalin ke `integrity_orphans` sebelum dihapus.
- Manifest ID duplikat tidak dihapus otomatis; harus ditinjau manual.
- `VALIDATE CONSTRAINT` dijalankan setelah orphan bersih; kegagalan membatalkan transaksi.
- Periksa laporan sebelum dan sesudah; jangan menjalankan `--apply` pada produksi tanpa persetujuan.

## Quarantine Recovery

Endpoint admin:

```text
GET  /api/admin/quarantine
GET  /api/admin/quarantine/:id
POST /api/admin/quarantine/:id/recover   { "confirm": true, "expectedPayloadHash": "..." }
```

- Super Admin dapat melihat seluruh tenant; Store Admin hanya tenant sendiri.
- Preview tidak mengembalikan payload mentah; hanya ringkasan dan status validitas.
- Recovery memerlukan konfirmasi eksplisit dan CSRF token.
- Payload harus JSON valid, manifest ID unik/format valid, dan evidence valid.
- State aktif sebelum recovery disalin ke `state_quarantine`.
- Recovery berjalan dalam transaksi; kegagalan rollback.
- Audit recovery disimpan append-only di `quarantine_recovery_audit`; trigger database menolak UPDATE/DELETE.
- Tidak ada recovery otomatis.

Retensi quarantine dapat dijalankan manual:

```sh
ORDERGUARD_QUARANTINE_RETENTION_DAYS=90 DATABASE_URL="..." npm run db:prune-quarantine
# setelah review:
ORDERGUARD_QUARANTINE_RETENTION_DAYS=90 DATABASE_URL="..." npm run db:prune-quarantine -- --apply --confirm orderguard
```

Quarantine yang sudah memiliki audit recovery tidak dihapus oleh prune.

## Backup Encryption, Offsite, RPO/RTO

Backup terenkripsi wajib memakai:

```sh
ORDERGUARD_BACKUP_ENCRYPTION_KEY="<32-byte-hex-64-char-atau-base64>"
```

- Algoritma: AES-256-GCM; IV acak per backup; authentication tag disimpan di metadata.
- Checksum ciphertext dan plaintext disimpan di `.sha256`/`.meta.json`.
- Kunci tidak pernah dicetak ke log dan tidak boleh disimpan di repository.
- Restore mendukung `ORDERGUARD_BACKUP_PREVIOUS_ENCRYPTION_KEYS` (dipisahkan koma) untuk rotasi kunci.
- `ORDERGUARD_BACKUP_OFFSITE_DIR` menyalin backup terverifikasi ke direktori mount/off-site; kegagalan off-site tidak menghapus backup lokal.
- Backup lokal/off-site lama tidak dihapus sebelum backup baru lolos verifikasi.
- Retensi: `ORDERGUARD_BACKUP_KEEP` (default 30).
- Untuk mode development tanpa enkripsi, set `ORDERGUARD_BACKUP_ALLOW_PLAINTEXT=1`; jangan gunakan di production.

**Prosedur rotasi key:**

1. Buat key baru dan simpan sebagai secret.
2. Pindahkan key lama ke `ORDERGUARD_BACKUP_PREVIOUS_ENCRYPTION_KEYS`, set key baru sebagai `ORDERGUARD_BACKUP_ENCRYPTION_KEY`.
3. Backup baru memakai key baru; backup lama tetap dapat direstore memakai key sebelumnya.
4. Setelah semua backup lama dipensiunkan, hapus key lama dari environment.

**Scheduler:** `render.yaml` menyediakan cron job harian pukul 02:00 untuk `npm run db:backup`. Backup harus disalin off-site; disk Render tidak boleh menjadi satu-satunya lokasi.

**RPO/RTO target:** RPO ≤ 24 jam dengan jadwal harian (perpendek jadwal bila diperlukan); RTO target ≤ 2 jam dengan restore terverifikasi ke database terpisah. Angka ini adalah target operasional, bukan jaminan; ukur ulang sesuai ukuran database dan kecepatan storage.
