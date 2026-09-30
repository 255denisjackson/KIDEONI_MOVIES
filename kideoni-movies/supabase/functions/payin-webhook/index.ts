import { createClient } from "npm:@supabase/supabase-js@2";

// PayIn calls this server-to-server when a payment succeeds or fails.
// There is no Supabase user session here — trust is established purely via
// the signature check below, not via a JWT. Keep PAYIN_WEBHOOK_SECRET only
// as an Edge Function secret, never in frontend code.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function verifySignature(rawBody: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const computed = Array.from(new Uint8Array(sigBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return computed === signature;
}

Deno.serve(async (req) => {
  try {
    const rawBody = await req.text();

    // ---- TODO: confirm the exact header name PayIn signs with, and adjust ----
    const signature = req.headers.get("X-PayIn-Signature");
    const webhookSecret = Deno.env.get("PAYIN_WEBHOOK_SECRET");
    if (webhookSecret) {
      const valid = await verifySignature(rawBody, signature, webhookSecret);
      if (!valid) return json({ error: "Invalid signature" }, 401);
    }

    const body = JSON.parse(rawBody);
    // ---- TODO: adjust these field names to PayIn's actual webhook payload ----
    const reference = body.reference || body.external_id;
    const status = body.status; // expected: 'success' | 'failed' | 'cancelled'
    const providerTxnId = body.transaction_id || body.id || null;

    if (!reference) return json({ error: "Missing reference" }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: payment } = await admin.from("payments").select("*").eq("id", reference).single();
    if (!payment) return json({ error: "Unknown payment reference" }, 404);

    const newStatus = status === "success" ? "success" : status === "cancelled" ? "cancelled" : "failed";

    await admin.from("payments").update({
      status: newStatus,
      payin_transaction_id: providerTxnId,
      raw_payload: rawBody,
    }).eq("id", payment.id);

    if (newStatus !== "success") {
      if (payment.subscription_id) {
        await admin.from("subscriptions").update({ status: newStatus }).eq("id", payment.subscription_id);
      }
      if (payment.verification_request_id) {
        await admin.from("verification_requests").update({ status: "rejected" }).eq("id", payment.verification_request_id);
      }
      return json({ received: true });
    }

    // ---- Subscription payment succeeded ----
    if (payment.subscription_id) {
      const { data: subscription } = await admin.from("subscriptions").select("*").eq("id", payment.subscription_id).single();
      if (subscription) {
        const { data: plan } = await admin.from("plans").select("*").eq("name", subscription.plan_id).single();
        const durationDays = plan?.duration_days ? Number(plan.duration_days) : 30;
        const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();

        await admin.from("subscriptions").update({
          status: "active",
          expires_at: expiresAt,
        }).eq("id", subscription.id);

        await admin.from("profiles").update({
          plan_id: subscription.plan_id,
          subscription_status: "active",
          subscription_expires_at: expiresAt,
        }).eq("id", subscription.user_id);
      }
    }

    // ---- Verification (blue tick) payment succeeded ----
    if (payment.verification_request_id) {
      await admin.from("verification_requests").update({ status: "approved" }).eq("id", payment.verification_request_id);
      const { data: vreq } = await admin.from("verification_requests").select("user_id").eq("id", payment.verification_request_id).single();
      if (vreq) {
        await admin.from("profiles").update({ is_verified: true }).eq("id", vreq.user_id);
      }
    }

    return json({ received: true });
  } catch (e) {
    return json({ error: e?.message || "Unexpected error" }, 500);
  }
});

