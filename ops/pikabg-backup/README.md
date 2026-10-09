# Pika.bg production backup system

These files are source copies of the working
production backup configuration.

They are NOT installed or activated by Git,
npm install, npm run dev, npm run build,
or any local development workflow.

Do not execute these scripts on development
computers.

## Production scripts

- scripts/pikabg-db-backup
  Runs the SQLite backup, compression,
  integrity verification and Drive upload.

- scripts/pikabg-db-retention
  Applies Google Drive retention:
  24 hours of 15-minute copies,
  hourly copies through 14 days,
  daily copies through 90 days.

## Production installation paths

Scripts:
  /usr/local/sbin/

Systemd units:
  /etc/systemd/system/

These files must be installed and enabled
manually on the production VPS only.

## Local backup retention

Compressed backups are kept locally
for 24 hours.

## Security

Never commit rclone.conf, OAuth credentials,
tokens, passwords, database files or backup
archives.

The production rclone configuration is managed
separately and securely on the VPS.

## Recovery

Restoring the backup automation on a new VPS
requires manual installation, systemd setup,
rclone authentication, and verification of a
restored database.

Do not activate the timers before validating
the new server configuration.
