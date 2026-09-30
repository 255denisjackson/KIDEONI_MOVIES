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
    const { plan_id, phone } = await req.json();
    if (!plan_id) return json({ error: "plan_id is required" }, 400);

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

    const { data: plan, error: planErr } = await admin.from("plans").select("*").eq("name", plan_id).eq("is_active", true).single();
    if (planErr || !plan) return json({ error: "That plan isn't available." }, 404);

    // ---------- Free plan: activate immediately, no payment needed ----------
    if (Number(plan.price) === 0) {
      const subId = crypto.randomUUID();
      await admin.from("subscriptions").insert({
        id: subId,
        user_id: user.id,
        plan_id: plan.name,
        status: "active",
        amount: "0",
        currency: plan.currency || "TZS",
        started_at: new Date().toISOString(),
        expires_at: null,
      });
      await admin.from("profiles").update({
        plan_id: plan.name,
        subscription_status: "active",
        subscription_expires_at: null,
      }).eq("id", user.id);

      return json({ ok: true });
    }

    // ---------- Paid plan ----------
    if (!phone) return json({ error: "A phone number is required to pay." }, 400);

    const subId = crypto.randomUUID();
    await admin.from("subscriptions").insert({
      id: subId,
      user_id: user.id,
      plan_id: plan.name,
      status: "pending",
      amount: String(plan.price),
      currency: plan.currency || "TZS",
      started_at: new Date().toISOString(),
      expires_at: null,
    });

    const paymentId = crypto.randomUUID();
    await admin.from("payments").insert({
      id: paymentId,
      subscription_id: subId,
      user_id: user.id,
      amount: String(plan.price),
      currency: plan.currency || "TZS",
      status: "pending",
      method: "mobile_money",
      created_at: new Date().toISOString(),
    });

    const payinSecret = Deno.env.get("PAYIN_SECRET_KEY");
    if (!payinSecret) {
      return json({
        error: "Payments aren't fully configured yet. Set PAYIN_SECRET_KEY as an Edge Function secret in the Supabase dashboard.",
      }, 500);
    }

    // ---- TODO: replace with PayIn's real checkout-initiation call. The
    // endpoint URL, request body, and response fields below are placeholders
    // — adjust to match PayIn's actual API docs. We send our own paymentId as
    // the "reference" so the webhook can look this exact row back up.
    const payinRes = await fetch("https://api.payin.example.com/v1/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${payinSecret}`,
      },
      body: JSON.stringify({
        amount: plan.price,
        currency: plan.currency || "TZS",
        phone,
        reference: paymentId,
        callback_url: `${supabaseUrl}/functions/v1/payin-webhook`,
      }),
    }).catch(() => null);

    if (!payinRes || !payinRes.ok) {
      await admin.from("payments").update({ status: "failed" }).eq("id", paymentId);
      await admin.from("subscriptions").update({ status: "failed" }).eq("id", subId);
      return json({ error: "Could not start the payment with PayIn. Please try again." }, 502);
    }

    const payinData = await payinRes.json().catch(() => ({}));
    await admin.from("payments").update({
      payin_transaction_id: payinData.reference || payinData.id || null,
      raw_payload: JSON.stringify(payinData),
    }).eq("id", paymentId).catch(() => {});

    if (payinData.checkout_url) return json({ checkout_url: payinData.checkout_url });
    return json({ instructions: "Approve the payment prompt sent to your phone, then refresh this page." });
  } catch (e) {
    return json({ error: e?.message || "Unexpected error" }, 500);
  }
});
