# Prosedur Rollback Staging

**Status: prosedur belum dijalankan.** Rollback hanya untuk staging; jangan pernah mengarahkan perintah ke produksi.

## Prinsip

- Rollback aplikasi dan rollback database adalah dua tindakan berbeda.
- Migrasi aplikasi bersifat additive dan tidak memiliki down migration.
- Jangan menjalankan restore ke database staging utama tanpa backup pra-rollback dan persetujuan operator.
- Uji restore ke database staging terpisah terlebih dahulu bila memungkinkan.
- Catat setiap tindakan dengan waktu, SHA, dan operator.

## Matriks keputusan

| Gejala | Tindakan |
|---|---|
| Health check gagal setelah deploy | Rollback aplikasi ke deploy sebelumnya |
| Error 5xx meningkat, data masih konsisten | Rollback aplikasi |
| Migrasi/startup gagal, aplikasi tidak bisa start | Rollback aplikasi; jika schema berubah, siapkan restore DB |
| Data korup/hilang karena release | Hentikan traffic, backup kondisi saat ini, restore backup pra-deploy ke DB terpisah, verifikasi, lalu restore ke staging utama |
| Backup/off-site gagal | Perbaiki runner; jangan hapus backup terakhir |
| Masalah keamanan | Cabut secret, rollback aplikasi, rotasi key, audit log |

## A. Rollback aplikasi

1. Buka Render service staging.
2. Pilih deploy sukses terakhir sebelum rilis bermasalah.
3. Lakukan **Rollback/Deploy** ke deploy tersebut.
4. Tunggu health check `/api/health` lulus.
5. Verifikasi login, `/api/state`, scan, handover, quarantine, dan laporan.
6. Catat SHA rollback dan deploy ID.

Rollback aplikasi tidak otomatis mengubah schema database. Karena migrasi additive, versi lama biasanya tetap kompatibel. Jika tidak, gunakan prosedur B.

## B. Rollback database

### B1. Backup kondisi saat ini terlebih dahulu

```sh
DATABASE_URL="$STAGING_DATABASE_URL" \
ORDERGUARD_BACKUP_ENCRYPTION_KEY="$ORDERGUARD_BACKUP_ENCRYPTION_KEY" \
ORDERGUARD_BACKUP_DIR=/tmp/orderguard-pre-rollback \
npm run db:backup
```

Simpan path dan checksum. Jangan melewati langkah ini.

### B2. Restore drill ke database staging terpisah

```sh
DATABASE_URL="$STAGING_RESTORE_DATABASE_URL" \
ORDERGUARD_CONFIRM_RESTORE="<nama-database-restore>" \
ORDERGUARD_BACKUP_ENCRYPTION_KEY="$ORDERGUARD_BACKUP_ENCRYPTION_KEY" \
ORDERGUARD_BACKUP_DIR=/tmp/orderguard-pre-deploy \
npm run db:restore -- /path/backup/orderguard-....dump.enc
```

Verifikasi:

- Script membandingkan jumlah baris tabel penting dengan metadata.
- Cek konsistensi user/tenant/TikTok/quarantine.
- Jalankan smoke test pada database restore.

### B3. Restore ke staging utama (destruktif)

Hanya setelah drill berhasil dan disetujui:

```sh
DATABASE_URL="$STAGING_DATABASE_URL" \
ORDERGUARD_CONFIRM_RESTORE="<nama-database-staging>" \
ORDERGUARD_BACKUP_ENCRYPTION_KEY="$ORDERGUARD_BACKUP_ENCRYPTION_KEY" \
ORDERGUARD_BACKUP_DIR=/tmp/orderguard-pre-rollback \
npm run db:restore -- /path/backup/orderguard-....dump.enc
```

Script membuat safety backup terenkripsi sebelum restore. Jangan menghapus safety backup tersebut.

### B4. Validasi pasca-rollback

- `/api/health` lulus.
- Login staging berhasil.
- Tenant dan user sesuai backup.
- Jumlah manifest/paket/insiden/audit sesuai catatan.
- Tidak ada referensi lintas tenant.
- Audit integritas bersih atau sesuai baseline.
- Backup/off-site tetap berfungsi.

## C. Rollback key/secret

Jika secret dicurigai bocor:

1. Rotasi password database staging.
2. Rotasi `ORDERGUARD_TOKEN_ENCRYPTION_KEY`; koneksi TikTok staging perlu diotorisasi ulang.
3. Rotasi `ORDERGUARD_BACKUP_ENCRYPTION_KEY`; gunakan `db:backup:rotate-keys` untuk backup lama.
4. Rotasi AWS access key staging dan batasi IAM.
5. Cabut session pengguna staging; trigger perubahan tenant mencabut session, atau nonaktifkan/aktifkan user.
6. Periksa `auth_audit`, `tenant_audit`, dan log akses.
7. Catat insiden dan bukti.

## D. Rollback drill wajib

Sebelum staging dinyatakan siap:

- [ ] Deploy versi N.
- [ ] Catat health dan smoke test.
- [ ] Deploy versi N+1.
- [ ] Rollback aplikasi ke N.
- [ ] Verifikasi health dan alur utama.
- [ ] Restore backup pra-deploy ke database staging terpisah.
- [ ] Verifikasi jumlah baris dan konsistensi.
- [ ] Catat waktu rollback dan bukti.

## Larangan

- Jangan rollback produksi dari prosedur ini.
- Jangan restore tanpa konfirmasi nama database.
- Jangan menghapus backup/safety backup.
- Jangan memakai kredensial produksi.
- Jangan mengklaim rollback berhasil tanpa eksekusi.
