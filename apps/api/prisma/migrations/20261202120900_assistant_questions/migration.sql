-- Questions the product assistant could not answer, for improving the docs.
-- Additive only: a new table with no foreign keys and no workspace columns.

-- CreateTable
CREATE TABLE "assistant_question" (
    "id" TEXT NOT NULL,
    "question" VARCHAR(500) NOT NULL,
    "reason" VARCHAR(32) NOT NULL,
    "closestSourceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "assistant_question_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_question_createdAt_idx" ON "assistant_question"("createdAt");

-- CreateIndex
CREATE INDEX "assistant_question_reason_createdAt_idx" ON "assistant_question"("reason", "createdAt");
