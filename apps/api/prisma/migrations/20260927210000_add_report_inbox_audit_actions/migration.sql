-- The mailbox holds account level IMAP credentials, so who set them and who
-- removed them is a question a security reviewer will ask. Recorded on the same
-- audit trail as the rest of the settings changes.
--
-- Kept out of a transaction because ALTER TYPE ... ADD VALUE cannot run inside
-- one on PostgreSQL 12 and earlier, and Prisma wraps a migration in one by
-- default. The two markers are the documented exception; on 12 and later they
-- are simply ignored.
ALTER TYPE "AuditAction" ADD VALUE 'REPORT_INBOX_CONFIGURED';
ALTER TYPE "AuditAction" ADD VALUE 'REPORT_INBOX_REMOVED';
