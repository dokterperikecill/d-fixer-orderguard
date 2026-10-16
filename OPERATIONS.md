# Operasi OrderGuard

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