CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exchange" text NOT NULL,
	"market_type" text NOT NULL,
	"symbol" text NOT NULL,
	"base_asset" text NOT NULL,
	"quote_asset" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_exchange_market_type_symbol" UNIQUE("exchange","market_type","symbol")
);
--> statement-breakpoint
CREATE TABLE "candles" (
	"asset_id" uuid NOT NULL,
	"timeframe" text NOT NULL,
	"open_time_ms" bigint NOT NULL,
	"close_time_ms" bigint NOT NULL,
	"open" numeric NOT NULL,
	"high" numeric NOT NULL,
	"low" numeric NOT NULL,
	"close" numeric NOT NULL,
	"volume" numeric NOT NULL,
	"quote_volume" numeric NOT NULL,
	"taker_buy_base_volume" numeric NOT NULL,
	"taker_buy_quote_volume" numeric NOT NULL,
	"trade_count" bigint NOT NULL,
	"is_closed" boolean NOT NULL,
	"outlier_checked" boolean NOT NULL,
	"source" text NOT NULL,
	"ingested_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candles_pkey" PRIMARY KEY("asset_id","timeframe","open_time_ms"),
	CONSTRAINT "candles_timeframe" CHECK ("candles"."timeframe" in ('15m', '1h', '4h', '1d'))
);
--> statement-breakpoint
CREATE TABLE "market_data_quarantine" (
	"source" text NOT NULL,
	"source_file" text NOT NULL,
	"row_index" integer NOT NULL,
	"symbol" text NOT NULL,
	"timeframe" text NOT NULL,
	"reason" text NOT NULL,
	"open_time_ms" bigint,
	"raw" text NOT NULL,
	"quarantined_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_data_quarantine_pkey" PRIMARY KEY("source_file","row_index","reason"),
	CONSTRAINT "market_data_quarantine_reason" CHECK ("market_data_quarantine"."reason" in ('malformed_row', 'bad_timestamp', 'timestamp_unit_mismatch', 'misaligned_open_time', 'bad_close_time', 'bad_number', 'non_positive_price', 'ohlc_inconsistent', 'volume_inconsistent', 'future_bar', 'outside_range', 'duplicate_conflict', 'outlier', 'stored_conflict'))
);
--> statement-breakpoint
ALTER TABLE "candles" ADD CONSTRAINT "candles_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;