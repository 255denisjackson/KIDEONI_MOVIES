import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Fixed verification fee — override by setting VERIFICATION_FEE_AMOUNT / _CURRENCY as Edge Function secrets.
const DEFAULT_FEE = "5000";
const DEFAULT_CURRENCY = "TZS";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { phone } = await req.json();

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "").trim();
    if (!token || token === anonKey) return json({ error: "Sign in first." }, 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Sign in first." }, 401);
    const user = userData.user;

    const { data: profile } = await admin.from("profiles").select("is_verified").eq("id", user.id).single();
    if (profile?.is_verified) return json({ error: "You're already verified." }, 400);

    const { data: existingPending } = await admin
      .from("verification_requests")
      .select("id")
      .eq("user_id", user.id)
      .eq("status", "pending")
      .limit(1);
    if (existingPending?.length) return json({ error: "You already have a verification request pending." }, 400);

    if (!phone) return json({ error: "A phone number is required to pay." }, 400);

    const amount = Deno.env.get("VERIFICATION_FEE_AMOUNT") || DEFAULT_FEE;
    const currency = Deno.env.get("VERIFICATION_FEE_CURRENCY") || DEFAULT_CURRENCY;

    const reqId = crypto.randomUUID();
    await admin.from("verification_requests").insert({
      id: reqId, user_id: user.id, status: "pending", amount, currency,
    });

    const paymentId = crypto.randomUUID();
    await admin.from("payments").insert({
      id: paymentId,
      user_id: user.id,
      verification_request_id: reqId,
      amount, currency,
      status: "pending",
      method: "mobile_money",
      created_at: new Date().toISOString(),
    });

    const payinSecret = Deno.env.get("PAYIN_SECRET_KEY");
    if (!payinSecret) {
      return json({ error: "Payments aren't fully configured yet. Set PAYIN_SECRET_KEY as an Edge Function secret." }, 500);
    }

    // ---- TODO: same placeholder PayIn call as create-payment; adjust to PayIn's real API ----
    const payinRes = await fetch("https://api.payin.example.com/v1/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${payinSecret}` },
      body: JSON.stringify({
        amount, currency, phone, reference: paymentId,
        callback_url: `${supabaseUrl}/functions/v1/payin-webhook`,
      }),
    }).catch(() => null);

    if (!payinRes || !payinRes.ok) {
      await admin.from("payments").update({ status: "failed" }).eq("id", paymentId);
      await admin.from("verification_requests").update({ status: "rejected" }).eq("id", reqId);
      return json({ error: "Could not start the payment with PayIn. Please try again." }, 502);
    }

    const payinData = await payinRes.json().catch(() => ({}));
    await admin.from("payments").update({
      payin_transaction_id: payinData.reference || payinData.id || null,
      raw_payload: JSON.stringify(payinData),
    }).eq("id", paymentId).catch(() => {});

    if (payinData.checkout_url) return json({ checkout_url: payinData.checkout_url });
    return json({ instructions: "Approve the payment prompt sent to your phone. Your blue tick appears automatically once it's confirmed." });
  } catch (e) {
    return json({ error: e?.message || "Unexpected error" }, 500);
  }
});
