-- CreateEnum
CREATE TYPE "CuratorBudgetMode" AS ENUM ('LEGACY', 'SHADOW', 'ACTIVE');

-- CreateEnum
CREATE TYPE "CuratorBudgetOutcome" AS ENUM ('FULL', 'DRAWDOWN', 'POOL_SHORT');

-- AlterTable
ALTER TABLE "PlatformFeeConfig" ADD COLUMN     "curatorBreakerArmPeriods" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "curatorBreakerFloorMedianPeriods" INTEGER NOT NULL DEFAULT 12,
ADD COLUMN     "curatorBreakerRatioBps" INTEGER NOT NULL DEFAULT 25000,
ADD COLUMN     "curatorBudgetAvgPeriods" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "curatorBudgetDrawdownWeeks" INTEGER NOT NULL DEFAULT 13,
ADD COLUMN     "curatorBudgetMode" "CuratorBudgetMode" NOT NULL DEFAULT 'LEGACY',
ADD COLUMN     "curatorBudgetMultBps" INTEGER NOT NULL DEFAULT 15000,
ADD COLUMN     "curatorTipCapShareBps" INTEGER NOT NULL DEFAULT 2500;

-- AlterTable
ALTER TABLE "RewardDistribution" ADD COLUMN     "appliedCuratorBudgetPiconeros" BIGINT,
ADD COLUMN     "breakerMakeupApproved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "breakerRawTPiconeros" BIGINT,
ADD COLUMN     "breakerTripped" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "curatorBudgetMode" "CuratorBudgetMode",
ADD COLUMN     "curatorBudgetParams" JSONB,
ADD COLUMN     "dynamicBudgetMode" "CuratorBudgetOutcome",
ADD COLUMN     "dynamicBudgetPiconeros" BIGINT,
ADD COLUMN     "eligibleTipStages" JSONB,
ADD COLUMN     "incomeF4Piconeros" BIGINT,
ADD COLUMN     "incomePiconeros" BIGINT,
ADD COLUMN     "makeupPiconeros" BIGINT,
ADD COLUMN     "multBps" INTEGER,
ADD COLUMN     "rawTipPiconeros" BIGINT,
ADD COLUMN     "reservePiconeros" BIGINT,
ADD COLUMN     "spendLimitPiconeros" BIGINT,
ADD COLUMN     "tipT4Piconeros" BIGINT,
ADD COLUMN     "tipperCount" INTEGER,
ADD COLUMN     "trustedTipPiconeros" BIGINT;
