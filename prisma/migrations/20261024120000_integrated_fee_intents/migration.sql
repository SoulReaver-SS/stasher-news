-- Integrated-address platform fees: generalize the owner-fee intent table
-- (additive only — no data rewrite, no table copy) and bind integrated
-- platform receipts to their issued payment id.

-- AlterTable
ALTER TABLE "FeeObservation" ADD COLUMN     "paymentId" TEXT;

-- AlterTable
ALTER TABLE "SubFeePidMap" ADD COLUMN     "fee_type" "FeeType",
ADD COLUMN     "post_id" INTEGER,
ADD COLUMN     "recipient_account_id" INTEGER,
ADD COLUMN     "recipient_address" TEXT,
ALTER COLUMN "subName" DROP NOT NULL,
ALTER COLUMN "owner_user_id" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "FeeObservation_paymentId_idx" ON "FeeObservation"("paymentId");

-- CreateIndex
CREATE INDEX "SubFeePidMap_recipient_account_id_idx" ON "SubFeePidMap"("recipient_account_id");

-- AddForeignKey
ALTER TABLE "SubFeePidMap" ADD CONSTRAINT "SubFeePidMap_recipient_account_id_fkey" FOREIGN KEY ("recipient_account_id") REFERENCES "MoneroAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A recipient id always travels with its address snapshot.
ALTER TABLE "SubFeePidMap" ADD CONSTRAINT "SubFeePidMap_recipient_snapshot_check"
CHECK (("recipient_account_id" IS NULL) = ("recipient_address" IS NULL));

-- A platform intent (fee_type set) must name its receiving account; an owner
-- intent (fee_type NULL) must keep its owner + turf attribution, which
-- ObservedSubFee rows copy (NOT NULL there).
ALTER TABLE "SubFeePidMap" ADD CONSTRAINT "SubFeePidMap_route_check"
CHECK (
  ("fee_type" IS NOT NULL AND "recipient_account_id" IS NOT NULL)
  OR ("fee_type" IS NULL AND "owner_user_id" IS NOT NULL AND "subName" IS NOT NULL)
);
