# Operasi OrderGuard

## PWA dan Aplikasi Desktop

Aplikasi web dapat dipasang di Android sebagai PWA setelah di-deploy melalui HTTPS. Manifest dan service worker disediakan oleh server; API `/api/` sengaja tidak disimpan ke cache, sehingga login dan sinkronisasi data tetap memerlukan koneksi ke server.

Cache PWA hanya menyimpan shell aplikasi. Setelah mengubah `app.js`, `styles.css`, atau aset shell lain, naikkan versi `CACHE_NAME` di `service-worker.js` agar perangkat mengambil aset rilis terbaru.

### Deploy ke Render

1. Push proyek ke repository GitHub, lalu di Render pilih **New → Blueprint** dan hubungkan repository tersebut.
2. Tinjau `render.yaml`, lalu deploy service. Konfigurasi menggunakan paket Render yang mendukung persistent disk; jangan ubah ke paket tanpa disk atau menambah instance karena SQLite hanya cocok untuk satu instance dengan disk yang sama.
3. Saat diminta, isi `ORDERGUARD_BOOTSTRAP_USERNAME`, `ORDERGUARD_BOOTSTRAP_NAME`, dan `ORDERGUARD_BOOTSTRAP_PASSWORD` sebagai environment variable rahasia di Render. Password harus minimal 12 karakter. Jangan simpan rahasia di repository atau kirim melalui chat.
4. Tunggu health check `/api/health` berhasil, lalu gunakan URL HTTPS `*.onrender.com` yang diberikan Render. Database dan backup diarahkan ke persistent disk `/var/data`.

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

Database baru tidak membuat akun demo. Tentukan bootstrap Platform Admin melalui environment saat menjalankan aplikasi:

```sh
NODE_ENV=production \
ORDERGUARD_BOOTSTRAP_USERNAME=platform-owner \
ORDERGUARD_BOOTSTRAP_NAME="Platform Owner" \
ORDERGUARD_BOOTSTRAP_PASSWORD="GANTI-DENGAN-RAHASIA-KUAT" \
npm start
```

Simpan password melalui secret manager, bukan file yang masuk Git atau log shell. Password bootstrap hanya digunakan jika tabel pengguna kosong. Untuk migrasi database demo lama, nonaktifkan/ganti seluruh akun demo dan passwordnya sebelum membuka layanan ke jaringan.

Production harus menggunakan HTTPS. Cookie sesi hanya diberi flag `Secure` saat `NODE_ENV=production`.

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

Access/refresh token disimpan terenkripsi di SQLite server dan tidak dikirim ke browser. Database serta kunci enkripsinya harus dicadangkan dan dipulihkan bersama. Jangan memasukkan kredensial aplikasi atau token ke repository, log, atau chat. Periksa Partner Center untuk endpoint, scope, dan persyaratan review ISV terbaru sebelum mengaktifkan integrasi produksi.

## Backup

Jalankan backup konsisten saat server hidup:

```sh
npm run db:backup
```

Secara default file disimpan di `data/backups/`, diverifikasi dengan `integrity_check`, dan retensi menyimpan 30 backup terakhir. Atur `ORDERGUARD_DB_PATH`, `ORDERGUARD_BACKUP_DIR`, atau `ORDERGUARD_BACKUP_KEEP` bila lokasi atau retensinya berbeda. Backup berisi data operasional dan wajib diperlakukan sebagai data sensitif.

## Restore

Hentikan server terlebih dahulu, lalu pulihkan dari backup yang sudah diverifikasi:

```sh
npm run db:restore -- data/backups/orderguard-YYYYMMDDTHHMMSSZ.sqlite
```

Jika database aktif tersedia, script membuat backup keselamatan sebelum menggantinya. Setelah restore berhasil, jalankan test/health check sebelum membuka layanan kembali. Jadwalkan backup rutin dan simpan salinan di media terpisah; script ini tidak menjadwalkan backup otomatis.