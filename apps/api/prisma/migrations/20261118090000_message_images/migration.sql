-- Several pictures per chat message (ADR 0009 amendment "several pictures"): the pictures move
-- from the single `messages.image_key` into `message_images`, the chat's twin of `post_images`.

-- CreateTable
CREATE TABLE "message_images" (
    "message_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    "key" TEXT NOT NULL,

    CONSTRAINT "message_images_pkey" PRIMARY KEY ("message_id","position")
);

-- CreateIndex
CREATE INDEX "message_images_key_idx" ON "message_images"("key");

-- The single picture of a message becomes its first. Every key has its upload row since the
-- foreign key of `richer_posts`.
INSERT INTO "message_images" ("message_id", "position", "key")
SELECT "id", 0, "image_key" FROM "messages" WHERE "image_key" IS NOT NULL;

-- DropForeignKey
ALTER TABLE "messages" DROP CONSTRAINT "messages_image_key_fkey";

-- DropIndex
DROP INDEX "messages_image_key_idx";

-- AlterTable
ALTER TABLE "messages" DROP COLUMN "image_key";

-- AddForeignKey
ALTER TABLE "message_images" ADD CONSTRAINT "message_images_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: an upload leaves with its owner's account, and so do the rows that show it.
ALTER TABLE "message_images" ADD CONSTRAINT "message_images_key_fkey" FOREIGN KEY ("key") REFERENCES "uploads"("key") ON DELETE CASCADE ON UPDATE CASCADE;
