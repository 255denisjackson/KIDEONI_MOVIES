import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Free (non-subscribed) viewers get this many seconds of any paid movie
// before playback is cut off client-side and they're asked to upgrade.
// Override with a PREVIEW_SECONDS Edge Function secret if you want a
// different length — it's just this one number.
const DEFAULT_PREVIEW_SECONDS = 120;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { content_type, content_id } = await req.json();
    if (!content_type || !content_id || !["movie", "reel"].includes(content_type)) {
      return json({ error: "content_type ('movie' or 'reel') and content_id are required" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "").trim();
    let user = null;
    if (token && token !== anonKey) {
      const { data } = await admin.auth.getUser(token);
      user = data?.user || null;
    }

    let profile: any = null;
    if (user) {
      const { data } = await admin.from("profiles").select("*").eq("id", user.id).single();
      profile = data;
    }
    const isAdmin = profile?.role === "admin";

    const table = content_type === "movie" ? "movies" : "reels";
    const { data: row, error } = await admin.from(table).select("*").eq("id", content_id).single();

    if (error || !row) return json({ error: "Content not found" }, 404);
    if (!row.is_published && !isAdmin) return json({ error: "This title isn't available." }, 404);
    if (!row.storage_path) return json({ error: "No video file has been uploaded for this title yet." }, 404);

    const url = row.storage_path.startsWith("http")
      ? row.storage_path
      : admin.storage.from(table).getPublicUrl(row.storage_path).data.publicUrl;

    // Reels are always fully free. Paid movies without an active subscription
    // get a timed preview instead of being blocked outright.
    if (content_type === "movie" && !row.is_free && !isAdmin) {
      const expires = profile?.subscription_expires_at ? new Date(profile.subscription_expires_at) : null;
      const activeSub = profile?.subscription_status === "active" && expires && expires.getTime() > Date.now();
      if (!activeSub) {
        const previewSeconds = Number(Deno.env.get("PREVIEW_SECONDS") || DEFAULT_PREVIEW_SECONDS);
        return json({ url, preview: true, preview_seconds: previewSeconds });
      }
    }

    return json({ url });
  } catch (e) {
    return json({ error: e?.message || "Unexpected error" }, 500);
  }
});
