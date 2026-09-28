-- When an instance started polling this mailbox.
--
-- Every instance starts the inbox scheduler on boot. Without a claim each one
-- opens a connection to the customer's mail host and reads the same cursor.
-- Bursting parallel logins at one host is how that host decides to block the
-- address, which would stop reports arriving for every customer in the mailbox
-- rather than just the slow one.
ALTER TABLE "report_inbox" ADD COLUMN "pollClaimedAt" TIMESTAMP(3);

-- The scheduler's own candidate query.
CREATE INDEX "report_inbox_enabled_pollClaimedAt_idx" ON "report_inbox"("enabled", "pollClaimedAt");
