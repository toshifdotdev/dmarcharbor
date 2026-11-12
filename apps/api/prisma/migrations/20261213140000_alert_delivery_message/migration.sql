-- The rendered message on each alert delivery, so a delivery a restart left
-- pending, or one that failed, can be sent again by the next alert pass.
-- Additive and nullable: rows from before have none and are not retried.
ALTER TABLE "alert_delivery" ADD COLUMN "message" JSONB;
