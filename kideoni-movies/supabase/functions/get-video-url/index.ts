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

    // Identify the caller, if any (logged-out viewers can still watch free content)
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

    // Reels are always free. Movies require is_free, admin, or an active subscription.
    if (content_type === "movie" && !row.is_free && !isAdmin) {
      if (!user) return json({ error: "Sign in to watch this title." }, 401);
      const expires = profile?.subscription_expires_at ? new Date(profile.subscription_expires_at) : null;
      const activeSub = profile?.subscription_status === "active" && expires && expires.getTime() > Date.now();
      if (!activeSub) return json({ error: "Upgrade your plan to watch this title." }, 403);
    }

    const url = row.storage_path.startsWith("http")
      ? row.storage_path
      : admin.storage.from(table).getPublicUrl(row.storage_path).data.publicUrl;

    return json({ url });
  } catch (e) {
    return json({ error: e?.message || "Unexpected error" }, 500);
  }
});
