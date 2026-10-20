-- AlterTable
ALTER TABLE "PlatformFeeConfig" ADD COLUMN     "distributionExcludedCuratorIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
