# Backup runner image: Node 24 + PostgreSQL 16 client + AWS CLI + rclone.
# Build from the repository root:
#   docker build -f ops/backup/Dockerfile -t orderguard-backup:latest .
FROM node:24-bookworm-slim

ARG POSTGRES_MAJOR=16

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
       "postgresql-client-${POSTGRES_MAJOR}" awscli rclone tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

RUN useradd --system --uid 10001 --gid root orderguard \
  && chown -R orderguard:root /app
USER orderguard

ENV NODE_ENV=production \
    ORDERGUARD_BACKUP_DIR=/tmp/orderguard-backups

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash", "-c", "node scripts/backup.js --check && node scripts/backup.js"]
