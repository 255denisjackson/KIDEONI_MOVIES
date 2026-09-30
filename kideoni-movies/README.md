# KIDEONI MOVIES

A streaming web app: free short-form reels + subscription-gated full movies.
Supabase for auth/database/storage/Edge Functions, plain HTML/CSS/JS frontend,
GitHub-hosted, payments via PayIn.

## What's in this folder

```
index.html          Home (hero, reels row, free movies, trending)
browse.html          Movie grid with search/genre/free filters
reels.html           Vertical swipe reel feed — like, comment, save, WhatsApp share
watch.html           Movie/reel player with native controls
login.html / signup.html
verify.html          Animated 6-digit email verification screen
pricing.html         Plans grid + PayIn checkout modal
account.html         Profile photo, blue tick, masked email, plan, saved items, billing
admin/index.html     Content studio — add/edit/publish movies & reels
css/styles.css        Whole design system (brand: #F25A24, white, black)
js/                   All client-side logic
supabase/schema.sql   Reference schema documentation
supabase/functions/   Edge Function source (also already deployed live)
```

## Honesty check — what's actually new vs. carried over

This project was built incrementally across a long debugging session. Some
pages existed before and were fixed; others (`index.html`, `login.html`,
`signup.html`, `pricing.html`, `admin/index.html`, `css/styles.css`) never
existed anywhere and were built fresh for this export, inferred from the
class names and element IDs the *other* files already depended on. If your
real site already has different versions of those files with content you
care about (copy, layout, extra sections), **do not blindly overwrite them**
— diff first.

## Before this goes live

1. **PayIn is a scaffold, not a working integration.** `create-payment`,
   `request-verification`, and `payin-webhook` have the auth, database
   writes, and error handling done, but the actual PayIn endpoint URL,
   request/response field names, and webhook signature header are
   placeholders marked `// TODO`. Get PayIn's real API docs, fill those in,
   then set as Edge Function secrets (Supabase dashboard → Edge Functions →
   Secrets) — never in frontend code:
   - `PAYIN_SECRET_KEY`
   - `PAYIN_WEBHOOK_SECRET`
   - `VERIFICATION_FEE_AMOUNT` / `VERIFICATION_FEE_CURRENCY` (optional, defaults to 5000 TZS)

2. **Email deliverability.** Supabase's built-in email sender is rate-limited
   (a handful of emails/hour) and this is a common source of "confirmation
   email never arrived" complaints. Set up custom SMTP (Resend, SendGrid,
   etc.) under Authentication → Emails → SMTP Settings.

3. **OTP email template.** For the 6-digit code in `verify.html` to actually
   work, your Supabase "Confirm signup" email template needs to include
   `{{ .Token }}`. Authentication → Email Templates → Confirm signup.

4. **True video protection.** Movie/reel files currently live in public
   storage buckets; `get-video-url` gates who *learns the URL*, but the URL
   itself isn't secret once handed out, and isn't time-limited. Real DRM-lite
   protection means moving to a private bucket and generating short-lived
   signed URLs instead — a bigger change, happy to do it if piracy risk is a
   real concern for you.

5. **Never tested end-to-end in a real browser.** Everything here is
   reasoned through carefully and syntax-checked, but I can't actually click
   through signup → verify → browse → watch → pay from this environment.
   Do a full run-through before sending traffic to it.

## Fixed this round

- **Root cause of "admin can't post movies" / "other accounts can't like or
  comment"**: there was no database trigger creating a `profiles` row on
  signup. Any account without one fails every admin check and every
  FK-linked write (likes/comments/saved_items all reference `profiles`).
  Added `handle_new_user()` + `on_auth_user_created` trigger, and backfilled
  the one account that was already missing its row.
- Instagram-style profile header on `account.html`: bigger avatar, the blue
  tick and the edit-pencil both sit on the ring's edge, a stats row
  (saved / liked / member since), and a **"Get verified ✓"** button that
  starts a paid verification request via `request-verification`.
- Comments now support **threaded replies** (`comments.parent_id`) and
  **voice notes** (`comments.audio_url`, recorded in-browser with
  `MediaRecorder`, uploaded to the `comment-audio` bucket).
- Replaced the 💬 emoji with a proper line-art icon for the comment button.
- Added mobile breakpoints (media queries) across the shared stylesheet and
  the home page hero.
- Added "Built by DENIS JACKSON" to every page footer.
- **Free preview cutoff**: non-subscribed viewers now get 2 minutes of any
  paid movie (instead of being blocked outright), then playback pauses with
  an upgrade prompt. Change the length by setting a `PREVIEW_SECONDS` Edge
  Function secret. Reels are unaffected — always fully free.
- Admin's "Duration" field for movies is no longer a manual number entry —
  it reads the real length from the video file the moment you choose it.
- **2GB uploads**: the `movies`/`reels` bucket limits are already set to 2GB,
  but Supabase enforces a project-wide *global* limit that overrides bucket
  limits, and on the Free plan that global limit is fixed at 50MB with no
  way to raise it. Getting large movie files to actually upload requires
  upgrading to the Pro plan (or higher), then raising "Global file size
  limit" under Storage → Settings in the dashboard. This is a billing/plan
  decision, not something fixable in code.

## Database

Already applied to the live Supabase project — `supabase/schema.sql` is a
reference export, not something you need to run. If you're setting up a
*new* environment from scratch, you'd need to recreate this schema properly
(ask me and I'll generate real migration files for that).
