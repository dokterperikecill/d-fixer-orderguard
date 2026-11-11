# Staging Release Deploy (VPS)

Script ini melakukan deploy atomik dari tag/SHA ke slot staging VPS:

```text
/opt/orderguard-staging/
  releases/<sha>/          # artefak git archive + npm ci --omit=dev
  current -> releases/<sha>
  deploy.sh                # salinan ops/staging/deploy-release.sh
```

## Deploy

```sh
sudo /opt/orderguard-staging/deploy.sh staging-2026-11-12
```

Langkah yang dilakukan:

1. Resolve tag/SHA ke commit.
2. `git archive` ke `releases/<sha>` (tidak menyentuh working tree).
3. `npm ci --omit=dev` sebagai user `orderguard`.
4. Update `ORDERGUARD_RELEASE` di `/etc/orderguard/staging.env`.
5. Switch symlink `current`, restart service.
6. Tunggu `/api/ready` (maks 30 detik).
7. Jika gagal, **rollback otomatis** ke release sebelumnya.

Log: `/var/log/orderguard-staging-deploy.log`.

## Rollback manual

```sh
sudo /opt/orderguard-staging/deploy.sh <sha-release-sebelumnya>
```

Atau arahkan symlink langsung:

```sh
sudo ln -sfn /opt/orderguard-staging/releases/<sha> /opt/orderguard-staging/current
sudo systemctl restart orderguard-staging.service
```

## Prasyarat

- Service `orderguard-staging.service` sudah terpasang.
- `/etc/orderguard/staging.env` berisi `ORDERGUARD_HOST=127.0.0.1` dan secret runtime.
- Node 24 di `/opt/node24`.
- User sistem `orderguard` dan direktori backup staging.
