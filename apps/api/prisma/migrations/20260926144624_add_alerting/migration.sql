-- CreateEnum
CREATE TYPE "AlertMetric" AS ENUM ('FAILURE_COUNT', 'FAILURE_RATE', 'SOURCE_IP_VOLUME', 'FORENSIC_FAILURES', 'REPORT_SILENCE');

-- CreateEnum
CREATE TYPE "AlertOperator" AS ENUM ('GREATER_THAN', 'GREATER_THAN_OR_EQUAL', 'LESS_THAN');

-- CreateEnum
CREATE TYPE "AlertChannel" AS ENUM ('EMAIL');

-- CreateEnum
CREATE TYPE "AlertDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED_QUIET_HOURS', 'SKIPPED_DISABLED');

-- CreateTable
CREATE TABLE "alert_rule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "createdById" TEXT,
    "name" TEXT NOT NULL,
    "metric" "AlertMetric" NOT NULL,
    "operator" "AlertOperator" NOT NULL,
    "threshold" INTEGER NOT NULL,
    "windowMinutes" INTEGER NOT NULL DEFAULT 1440,
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 1440,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastTriggeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_recipient" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_recipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_event" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "metric" "AlertMetric" NOT NULL,
    "operator" "AlertOperator" NOT NULL,
    "observedValue" INTEGER NOT NULL,
    "threshold" INTEGER NOT NULL,
    "windowMinutes" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "context" JSONB,
    "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_delivery" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" "AlertChannel" NOT NULL DEFAULT 'EMAIL',
    "status" "AlertDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emailAlerts" BOOLEAN NOT NULL DEFAULT true,
    "quietHoursStart" TEXT,
    "quietHoursEnd" TEXT,
    "onlyHighRiskAlerts" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_rule_organizationId_enabled_idx" ON "alert_rule"("organizationId", "enabled");

-- CreateIndex
CREATE INDEX "alert_rule_domainId_enabled_idx" ON "alert_rule"("domainId", "enabled");

-- CreateIndex
CREATE INDEX "alert_rule_enabled_lastTriggeredAt_idx" ON "alert_rule"("enabled", "lastTriggeredAt");

-- CreateIndex
CREATE INDEX "alert_recipient_ruleId_idx" ON "alert_recipient"("ruleId");

-- CreateIndex
CREATE UNIQUE INDEX "alert_recipient_ruleId_userId_key" ON "alert_recipient"("ruleId", "userId");

-- CreateIndex
CREATE INDEX "alert_event_ruleId_triggeredAt_idx" ON "alert_event"("ruleId", "triggeredAt");

-- CreateIndex
CREATE INDEX "alert_event_domainId_triggeredAt_idx" ON "alert_event"("domainId", "triggeredAt");

-- CreateIndex
CREATE INDEX "alert_event_organizationId_triggeredAt_idx" ON "alert_event"("organizationId", "triggeredAt");

-- CreateIndex
CREATE INDEX "alert_delivery_userId_status_idx" ON "alert_delivery"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "alert_delivery_eventId_userId_channel_key" ON "alert_delivery"("eventId", "userId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preference_userId_key" ON "notification_preference"("userId");

-- AddForeignKey
ALTER TABLE "alert_rule" ADD CONSTRAINT "alert_rule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rule" ADD CONSTRAINT "alert_rule_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rule" ADD CONSTRAINT "alert_rule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_recipient" ADD CONSTRAINT "alert_recipient_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "alert_rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_event" ADD CONSTRAINT "alert_event_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "alert_rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_event" ADD CONSTRAINT "alert_event_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_event" ADD CONSTRAINT "alert_event_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_delivery" ADD CONSTRAINT "alert_delivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "alert_event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_delivery" ADD CONSTRAINT "alert_delivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
