-- New DNS change kinds in their own migration: Postgres cannot use a value in
-- the transaction that adds it.
ALTER TYPE "DnsChangeKind" ADD VALUE IF NOT EXISTS 'MTA_STS';
ALTER TYPE "DnsChangeKind" ADD VALUE IF NOT EXISTS 'TLS_RPT';
ALTER TYPE "DnsChangeKind" ADD VALUE IF NOT EXISTS 'BIMI';
