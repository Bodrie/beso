-- AlterEnum
ALTER TYPE "upload_kind" ADD VALUE 'group';

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "picture_key" TEXT;

-- CreateIndex
CREATE INDEX "conversations_picture_key_idx" ON "conversations"("picture_key");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_picture_key_fkey" FOREIGN KEY ("picture_key") REFERENCES "uploads"("key") ON DELETE SET NULL ON UPDATE CASCADE;
