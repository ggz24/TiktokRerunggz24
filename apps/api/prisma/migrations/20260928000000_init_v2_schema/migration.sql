-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "LicensePlan" AS ENUM ('TRIAL', 'BASIC', 'PRO', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "LicenseStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "AuthType" AS ENUM ('COOKIE', 'OAUTH', 'HYBRID');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('CONNECTED', 'EXPIRED', 'DISCONNECTED', 'INVALID_CREDENTIALS');

-- CreateEnum
CREATE TYPE "VideoStatus" AS ENUM ('UPLOADING', 'READY', 'PROCESSING', 'ERROR');

-- CreateEnum
CREATE TYPE "PlaylistLoopMode" AS ENUM ('LOOP', 'SEQUENTIAL', 'SHUFFLE', 'ONCE');

-- CreateEnum
CREATE TYPE "CommonStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "LiveSessionMode" AS ENUM ('RERUN', 'PLAYLIST', 'SCHEDULED', 'MANUAL');

-- CreateEnum
CREATE TYPE "LiveSessionStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'STARTING', 'LIVE', 'STOPPED', 'COMPLETED', 'ERROR');

-- CreateEnum
CREATE TYPE "TriggerType" AS ENUM ('KEYWORD', 'REGEX', 'INTENT', 'EXACT');

-- CreateEnum
CREATE TYPE "AiProvider" AS ENUM ('OPENAI', 'ANTHROPIC', 'GEMINI', 'LOCAL', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ReplyStatus" AS ENUM ('PENDING', 'REPLIED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "AiLogStatus" AS ENUM ('SUCCESS', 'FAILED', 'TIMEOUT');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(255) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" VARCHAR(120),
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "licenses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "license_key" VARCHAR(120) NOT NULL,
    "plan" "LicensePlan" NOT NULL DEFAULT 'BASIC',
    "status" "LicenseStatus" NOT NULL DEFAULT 'ACTIVE',
    "max_accounts" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "licenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "platform" VARCHAR(30) NOT NULL DEFAULT 'TIKTOK',
    "account_uid" VARCHAR(160) NOT NULL,
    "display_name" VARCHAR(120),
    "avatar_url" TEXT,
    "auth_type" "AuthType" NOT NULL DEFAULT 'COOKIE',
    "access_token_enc" TEXT,
    "refresh_token_enc" TEXT,
    "token_expires_at" TIMESTAMPTZ(6),
    "cookie_enc" TEXT,
    "cookie_expires_at" TIMESTAMPTZ(6),
    "encryption_key_id" VARCHAR(64) NOT NULL DEFAULT 'v1',
    "encryption_iv" TEXT,
    "credentials_updated_at" TIMESTAMPTZ(6),
    "last_verified_at" TIMESTAMPTZ(6),
    "account_metadata" JSONB NOT NULL DEFAULT '{}',
    "status" "AccountStatus" NOT NULL DEFAULT 'CONNECTED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "greeting_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "message" TEXT NOT NULL,
    "delay_sec" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "greeting_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_settings" (
    "account_id" UUID NOT NULL,
    "timezone" VARCHAR(50) NOT NULL DEFAULT 'Asia/Bangkok',
    "default_greeting_id" UUID,
    "ai_enabled" BOOLEAN NOT NULL DEFAULT false,
    "stats_interval_sec" INTEGER NOT NULL DEFAULT 30,
    "auto_restart" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_settings_pkey" PRIMARY KEY ("account_id")
);

-- CreateTable
CREATE TABLE "videos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "file_url" TEXT NOT NULL,
    "duration_sec" INTEGER,
    "file_size_bytes" BIGINT,
    "resolution" VARCHAR(20),
    "status" "VideoStatus" NOT NULL DEFAULT 'READY',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "videos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playlists" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "loop_mode" "PlaylistLoopMode" NOT NULL DEFAULT 'LOOP',
    "status" "CommonStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playlists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playlist_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "playlist_id" UUID NOT NULL,
    "video_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playlist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_sets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "items_json" JSONB NOT NULL DEFAULT '[]',
    "status" "CommonStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "video_id" UUID,
    "playlist_id" UUID,
    "product_set_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "mode" "LiveSessionMode" NOT NULL DEFAULT 'RERUN',
    "status" "LiveSessionStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduled_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reply_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "trigger_type" "TriggerType" NOT NULL,
    "trigger_value" TEXT NOT NULL,
    "response_text" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reply_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "provider" "AiProvider" NOT NULL,
    "model" VARCHAR(120) NOT NULL,
    "system_prompt" TEXT,
    "temperature" DECIMAL(3,2) DEFAULT 0.70,
    "max_tokens" INTEGER DEFAULT 500,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comment_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "live_session_id" UUID NOT NULL,
    "reply_rule_id" UUID,
    "platform_comment_id" VARCHAR(200) NOT NULL,
    "username" VARCHAR(120),
    "comment_text" TEXT NOT NULL,
    "reply_text" TEXT,
    "reply_status" "ReplyStatus" NOT NULL DEFAULT 'PENDING',
    "commented_at" TIMESTAMPTZ(6) NOT NULL,
    "replied_at" TIMESTAMPTZ(6),

    CONSTRAINT "comment_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ai_config_id" UUID NOT NULL,
    "comment_log_id" UUID,
    "request_text" TEXT,
    "response_text" TEXT,
    "model" VARCHAR(120),
    "status" "AiLogStatus" NOT NULL DEFAULT 'SUCCESS',
    "latency_ms" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stats_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "live_session_id" UUID NOT NULL,
    "captured_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "gmv" DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    "sold" INTEGER NOT NULL DEFAULT 0,
    "viewers" INTEGER NOT NULL DEFAULT 0,
    "enters" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "gmv_per_hour" DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    "impressions_per_hour" DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "orders" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "stats_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "licenses_license_key_key" ON "licenses"("license_key");

-- CreateIndex
CREATE INDEX "idx_licenses_user_status" ON "licenses"("user_id", "status");

-- CreateIndex
CREATE INDEX "idx_accounts_user_status" ON "accounts"("user_id", "status");

-- CreateIndex
CREATE INDEX "idx_accounts_platform_status" ON "accounts"("platform", "status");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_platform_account_uid_key" ON "accounts"("platform", "account_uid");

-- CreateIndex
CREATE INDEX "idx_videos_account_status" ON "videos"("account_id", "status");

-- CreateIndex
CREATE INDEX "idx_playlists_account_status" ON "playlists"("account_id", "status");

-- CreateIndex
CREATE INDEX "idx_playlist_items_playlist_order" ON "playlist_items"("playlist_id", "sort_order");

-- CreateIndex
CREATE INDEX "idx_playlist_items_video" ON "playlist_items"("video_id");

-- CreateIndex
CREATE UNIQUE INDEX "playlist_items_playlist_id_sort_order_key" ON "playlist_items"("playlist_id", "sort_order");

-- CreateIndex
CREATE INDEX "idx_product_sets_account_status" ON "product_sets"("account_id", "status");

-- CreateIndex
CREATE INDEX "idx_live_sessions_account_status_started" ON "live_sessions"("account_id", "status", "started_at");

-- CreateIndex
CREATE INDEX "idx_live_sessions_status_scheduled" ON "live_sessions"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "idx_reply_rules_account_enabled_priority" ON "reply_rules"("account_id", "enabled", "priority");

-- CreateIndex
CREATE INDEX "idx_ai_config_account_enabled" ON "ai_configs"("account_id", "enabled");

-- CreateIndex
CREATE INDEX "idx_comments_live_time" ON "comment_logs"("live_session_id", "commented_at" DESC);

-- CreateIndex
CREATE INDEX "idx_comments_status" ON "comment_logs"("reply_status");

-- CreateIndex
CREATE INDEX "idx_ai_logs_comment_time" ON "ai_logs"("comment_log_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_ai_logs_config_time" ON "ai_logs"("ai_config_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_stats_live_time" ON "stats_snapshots"("live_session_id", "captured_at" DESC);

-- AddForeignKey
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greeting_configs" ADD CONSTRAINT "greeting_configs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_default_greeting_id_fkey" FOREIGN KEY ("default_greeting_id") REFERENCES "greeting_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "videos" ADD CONSTRAINT "videos_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist_items" ADD CONSTRAINT "playlist_items_playlist_id_fkey" FOREIGN KEY ("playlist_id") REFERENCES "playlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist_items" ADD CONSTRAINT "playlist_items_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_sets" ADD CONSTRAINT "product_sets_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_playlist_id_fkey" FOREIGN KEY ("playlist_id") REFERENCES "playlists"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_product_set_id_fkey" FOREIGN KEY ("product_set_id") REFERENCES "product_sets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reply_rules" ADD CONSTRAINT "reply_rules_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_configs" ADD CONSTRAINT "ai_configs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_logs" ADD CONSTRAINT "comment_logs_live_session_id_fkey" FOREIGN KEY ("live_session_id") REFERENCES "live_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_logs" ADD CONSTRAINT "comment_logs_reply_rule_id_fkey" FOREIGN KEY ("reply_rule_id") REFERENCES "reply_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_logs" ADD CONSTRAINT "ai_logs_ai_config_id_fkey" FOREIGN KEY ("ai_config_id") REFERENCES "ai_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_logs" ADD CONSTRAINT "ai_logs_comment_log_id_fkey" FOREIGN KEY ("comment_log_id") REFERENCES "comment_logs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stats_snapshots" ADD CONSTRAINT "stats_snapshots_live_session_id_fkey" FOREIGN KEY ("live_session_id") REFERENCES "live_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Keep updated_at accurate for direct SQL writes as well as Prisma Client writes.
CREATE OR REPLACE FUNCTION trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_timestamp_users BEFORE UPDATE ON users FOR EACH ROW EXECUTE PROCEDURE trigger_set_timestamp();
CREATE TRIGGER set_timestamp_licenses BEFORE UPDATE ON licenses FOR EACH ROW EXECUTE PROCEDURE trigger_set_timestamp();
CREATE TRIGGER set_timestamp_accounts BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE PROCEDURE trigger_set_timestamp();
CREATE TRIGGER set_timestamp_greeting_configs BEFORE UPDATE ON greeting_configs FOR EACH ROW EXECUTE PROCEDURE trigger_set_timestamp();
CREATE TRIGGER set_timestamp_account_settings BEFORE UPDATE ON account_settings FOR EACH ROW EXECUTE PROCEDURE trigger_set_timestamp();
CREATE TRIGGER set_timestamp_videos BEFORE UPDATE ON videos FOR EACH ROW EXECUTE PROCEDURE trigger_set_timestamp();
CREATE TRIGGER set_timestamp_playlists BEFORE UPDATE ON playlists FOR EACH ROW EXECUTE PROCEDURE trigger_set_timestamp();
CREATE TRIGGER set_timestamp_playlist_items BEFORE UPDATE ON playlist_items FOR EACH ROW EXECUTE PROCEDURE trigger_set_timestamp();
CREATE TRIGGER set_timestamp_product_sets BEFORE UPDATE ON product_sets FOR EACH ROW EXECUTE PROCEDURE trigger_set_timestamp();
CREATE TRIGGER set_timestamp_live_sessions BEFORE UPDATE ON live_sessions FOR EACH ROW EXECUTE PROCEDURE trigger_set_timestamp();
CREATE TRIGGER set_timestamp_reply_rules BEFORE UPDATE ON reply_rules FOR EACH ROW EXECUTE PROCEDURE trigger_set_timestamp();
CREATE TRIGGER set_timestamp_ai_configs BEFORE UPDATE ON ai_configs FOR EACH ROW EXECUTE PROCEDURE trigger_set_timestamp();
