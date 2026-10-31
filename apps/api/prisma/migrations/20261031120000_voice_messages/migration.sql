-- AlterEnum
ALTER TYPE "upload_kind" ADD VALUE 'voice';

-- AlterTable
ALTER TABLE "uploads" ADD COLUMN     "duration_ms" INTEGER;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "voice_key" TEXT,
ADD COLUMN     "voice_peaks" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[];

-- CreateIndex
CREATE INDEX "messages_voice_key_idx" ON "messages"("voice_key");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_voice_key_fkey" FOREIGN KEY ("voice_key") REFERENCES "uploads"("key") ON DELETE SET NULL ON UPDATE CASCADE;
