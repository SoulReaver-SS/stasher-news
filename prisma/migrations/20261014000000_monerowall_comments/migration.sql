-- Monerowall-covered discussions (2026-10-14): the wall's scope can include
-- the comment section. `moneroWallCoversComments` is create-time-only (set
-- with the wall args); `moneroWallCommentsRemovedAt` is the one-way lift
-- stamped by openMoneroWallComments. Removing the whole wall
-- (removeMoneroWall) opens the discussion with it — no backfill needed,
-- existing posts default to false/null.
--
-- Draft carries the create-time flag so drafts survive reloads.

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "moneroWallCoversComments" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "moneroWallCommentsRemovedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "draft" ADD COLUMN     "moneroWallCoversComments" BOOLEAN;
