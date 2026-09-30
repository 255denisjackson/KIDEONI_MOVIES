-- KIDEONI MOVIES — schema reference
--
-- This documents the CURRENT state of the live Supabase project
-- (axsjakqscudnbxjnfkrw) as of this export. It is a reference for version
-- control and onboarding new contributors — it is NOT meant to be run
-- against a fresh database end-to-end, since some tables pre-date this
-- file and their original full DDL isn't reproduced here from scratch.
-- Going forward, make schema changes as new dated migration files rather
-- than editing this one.

-- ============================================================
-- Core content
-- ============================================================

-- movies, reels: both have a UUID `id` as primary key (added after the
-- fact — they originally used `title` as PK, which broke every query the
-- frontend made). `title` remains unique. `genres` is text[].
--   id uuid primary key default gen_random_uuid()
--   title text unique not null
--   slug text
--   synopsis text
--   release_year int / rating text / genres text[] / cast_list text
--   duration_seconds int / trailer_url text
--   poster_url text / backdrop_url text / storage_path text
--   is_free boolean / is_featured boolean / is_published boolean
--   view_count int default 0 / like_count int default 0
--   created_at timestamptz default now()
--
-- reels additionally has:
--   caption text / thumbnail_url text
--   related_movie_id uuid references movies(id) on delete set null

-- profiles: id = auth.users.id (as text), one row per account.
--   id text primary key
--   email text, full_name text, avatar_url text
--   role text ('user' | 'admin')
--   is_verified boolean default false          -- blue tick
--   plan_id text references plans(name) on update cascade on delete set null
--   subscription_status text, subscription_expires_at text
--   created_at timestamptz default now()

-- plans: pricing tiers.
--   name text primary key
--   price bigint, currency text, duration_days bigint
--   features jsonb, is_active boolean, sort_order bigint

-- subscriptions / payments: transactional records tied to a plan purchase.
-- NOTE: most columns here are `text`, including numeric/boolean-looking
-- ones — this was the state of the table before this project touched it.
-- subscriptions: id, user_id, plan_id, status, amount, currency,
--                payin_reference, started_at, expires_at
-- payments: id, subscription_id, user_id, payin_transaction_id, amount,
--           currency, status, method, raw_payload, created_at (added)

-- content_views: raw per-heartbeat watch analytics, written by the
-- track-view Edge Function.
--   id text, content_type text, content_id uuid, user_id text,
--   session_id text, watch_seconds text, percent_complete text,
--   completed text, device text, created_at timestamptz default now() (added)

-- ============================================================
-- Social features
-- ============================================================

create table if not exists public.likes (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles(id) on delete cascade,
  content_type text not null check (content_type in ('movie','reel')),
  content_id uuid not null,
  created_at timestamptz not null default now(),
  unique (user_id, content_type, content_id)
);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles(id) on delete cascade,
  content_type text not null check (content_type in ('movie','reel')),
  content_id uuid not null,
  body text not null check (char_length(body) between 1 and 1000),
  is_deleted boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.saved_items (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles(id) on delete cascade,
  content_type text not null check (content_type in ('movie','reel')),
  content_id uuid not null,
  created_at timestamptz not null default now(),
  unique (user_id, content_type, content_id)
);

-- Keeps movies.like_count / reels.like_count in sync automatically —
-- see sync_like_count() trigger function, fired after insert/delete on likes.

create table if not exists public.verification_requests (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','paid','approved','rejected')),
  amount text,
  currency text default 'TZS',
  created_at timestamptz not null default now()
);
-- payments.verification_request_id links a payment to the request it's paying for.

-- comments.parent_id (self-referencing) enables threaded replies.
-- comments.audio_url + relaxed body constraint enables voice-note comments
-- (body is required only when audio_url is absent).

-- ============================================================
-- Auth trigger — CRITICAL, do not remove
-- ============================================================
-- public.handle_new_user(), fired by trigger on_auth_user_created after
-- insert on auth.users, auto-creates the matching profiles row for every
-- new signup. Before this existed, any account created via signup had NO
-- profiles row, which silently broke every FK-linked feature (likes,
-- comments, saved_items) for that account, and made admin checks always
-- fail. This is the single most important trigger in the whole schema.

-- ============================================================
-- Functions
-- ============================================================
-- public.is_admin() — true if the current auth.uid() has role = 'admin'.
--   Used throughout RLS policies.
-- public.sync_like_count() — trigger function, keeps like_count columns
--   in sync with the likes table.
-- public.admin_analytics() — admin-only RPC, returns site-wide totals,
--   a 14-day view trend, and top 5 movies/reels.
-- public.content_analytics(p_content_type text, p_content_id uuid) —
--   admin-only RPC, per-title view/like/comment stats and 14-day trend.

-- ============================================================
-- Storage buckets
-- ============================================================
-- movies   (public)  — poster/backdrop images AND movie video files
-- reels    (public)  — thumbnail images AND reel video files
-- avatars  (public)  — profile photos, write restricted to the owner's
--                       own folder: avatars/<user_id>/...
--
-- Video files are served by constructing/using their public URL directly
-- via the get-video-url Edge Function, which also enforces free/paid
-- gating and published-only visibility server-side. Direct bucket URLs are
-- technically guessable since the buckets are public — genuine DRM would
-- require migrating to a private bucket + real signed URLs (see README).

-- ============================================================
-- Row Level Security
-- ============================================================
-- Enabled on every table above. General pattern:
--  - public content (movies/reels where is_published, plans where
--    is_active, profiles, likes, non-deleted comments): readable by
--    anon + authenticated
--  - writes to movies/reels/plans: admin only (public.is_admin())
--  - likes/comments/saved_items: each user can only insert/delete their
--    own rows; admins can moderate (delete) any comment
--  - subscriptions/payments: a user can see their own; admins see all
