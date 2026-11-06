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

Integrasi tersedia untuk aplikasi ISV yang sudah disetujui di TikTok Shop Partner Center. Sinkronisasi bersifat read-only: OrderGuard hanya mengambil pesanan yang telah memiliki nomor resi, dan pengguna harus meninjau hasil sebelum membuat manifest. Sinkronisasi mencari pesanan yang diperbarui dalam 30 hari terakhir; pesanan tanpa resi dilewati.

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

## Restore

Pulihkan dari backup custom-format yang sudah diverifikasi:

```sh
npm run db:restore -- data/backups/orderguard-YYYYMMDDTHHMMSSZ.dump
```

Script membuat backup keselamatan terlebih dahulu, lalu memulihkan objek dari arsip ke database `DATABASE_URL` menggunakan `pg_restore --clean`. Setelah restore berhasil, jalankan test/health check sebelum membuka layanan kembali. Jadwalkan backup rutin dan simpan salinan di media terpisah; script ini tidak menjadwalkan backup otomatis.