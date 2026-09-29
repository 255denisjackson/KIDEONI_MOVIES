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
    const body = await req.json();
    const { content_type, content_id, session_id, watch_seconds, percent_complete, completed, device } = body;
    if (!content_type || !content_id || !session_id) {
      return json({ error: "content_type, content_id and session_id are required" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "").trim();
    let userId: string | null = null;
    if (token && token !== anonKey) {
      const { data } = await admin.auth.getUser(token);
      userId = data?.user?.id || null;
    }

    const { data: existing } = await admin
      .from("content_views")
      .select("id")
      .eq("content_type", content_type)
      .eq("content_id", content_id)
      .eq("session_id", session_id)
      .limit(1);

    const isFirstHeartbeat = !existing || existing.length === 0;

    await admin.from("content_views").insert({
      id: crypto.randomUUID(),
      content_type,
      content_id,
      user_id: userId,
      session_id,
      watch_seconds: String(watch_seconds ?? 0),
      percent_complete: String(percent_complete ?? 0),
      completed: String(!!completed),
      device: device ?? null,
    });

    if (isFirstHeartbeat && (content_type === "movie" || content_type === "reel")) {
      const table = content_type === "movie" ? "movies" : "reels";
      const { data: row } = await admin.from(table).select("view_count").eq("id", content_id).single();
      if (row) {
        await admin.from(table).update({ view_count: (row.view_count ?? 0) + 1 }).eq("id", content_id);
      }
    }

    return json({ ok: true });
  } catch (e) {
    return json({ error: e?.message || "Unexpected error" }, 500);
  }
});
