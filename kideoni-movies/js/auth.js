// js/auth.js — signup, login, real email verification, logout.
// Email confirmation is handled entirely by Supabase Auth (enable
// "Confirm email" under Authentication → Providers → Email in your
// Supabase project). No custom OTP/email code needed or wanted here.

function showMsg(el, text, type) {
  el.textContent = text;
  el.className = `form-msg show ${type}`;
}

// ---------------- Sign up ----------------
async function handleSignup(e) {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector("button[type=submit]");
  const msg = document.getElementById("formMsg");
  const fullName = form.fullName.value.trim();
  const email = form.email.value.trim();
  const password = form.password.value;

  if (password.length < 8) {
    showMsg(msg, "Password must be at least 8 characters.", "error");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Creating account…";

  const { data, error } = await window.sb.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName },
    },
  });

  if (error) {
    showMsg(msg, error.message, "error");
    btn.disabled = false;
    btn.textContent = "Create account";
    return;
  }

  sessionStorage.setItem("kideoni_pending_email", email);
  location.href = `verify.html?email=${encodeURIComponent(email)}`;
}

// ---------------- Log in ----------------
async function handleLogin(e) {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector("button[type=submit]");
  const msg = document.getElementById("formMsg");
  const email = form.email.value.trim();
  const password = form.password.value;

  btn.disabled = true;
  btn.textContent = "Signing in…";

  const { data, error } = await window.sb.auth.signInWithPassword({ email, password });

  if (error) {
    if (/confirm/i.test(error.message)) {
      location.href = `verify.html?email=${encodeURIComponent(email)}`;
      return;
    }
    showMsg(msg, error.message, "error");
    btn.disabled = false;
    btn.textContent = "Sign in";
    return;
  }

  const params = new URLSearchParams(location.search);
  location.href = params.get("redirect") || "index.html";
}

// ---------------- Verification screen (OTP code) ----------------
async function initVerifyScreen() {
  const params = new URLSearchParams(location.search);
  const email = params.get("email") || sessionStorage.getItem("kideoni_pending_email") || "";
  const emailLabel = document.getElementById("verifyEmailLabel");
  if (emailLabel) emailLabel.textContent = email || "your email";

  const statusEl = document.getElementById("verifyStatus");
  const mailIcon = document.getElementById("verifyMailIcon");
  const resendBtn = document.getElementById("resendBtn");
  const codeInput = document.getElementById("otpInput");
  const verifyBtn = document.getElementById("verifyBtn");

  function markVerified() {
    mailIcon.textContent = "✓";
    mailIcon.classList.add("success");
    statusEl.innerHTML = `Email verified — welcome to KIDEONI!`;
    statusEl.classList.add("success");
    if (codeInput) codeInput.parentElement.style.display = "none";
  }

  // Already have a confirmed session (e.g. verified in another tab)? Skip straight through.
  const {
    data: { session },
  } = await window.sb.auth.getSession();
  if (session?.user?.email_confirmed_at) {
    markVerified();
    setTimeout(() => (location.href = "index.html"), 1200);
    return;
  }

  window.sb.auth.onAuthStateChange((event, s) => {
    if (event === "SIGNED_IN" && s?.user?.email_confirmed_at) {
      markVerified();
      setTimeout(() => (location.href = "index.html"), 1200);
    }
  });

  verifyBtn?.addEventListener("click", async () => {
    const code = (codeInput?.value || "").trim();
    if (!/^\d{6}$/.test(code)) {
      statusEl.textContent = "Enter the 6-digit code from your email.";
      return;
    }
    verifyBtn.disabled = true;
    const original = verifyBtn.textContent;
    verifyBtn.textContent = "Verifying…";

    const { error } = await window.sb.auth.verifyOtp({ email, token: code, type: "signup" });

    if (error) {
      statusEl.textContent = error.message || "That code didn't work — check it and try again.";
      verifyBtn.disabled = false;
      verifyBtn.textContent = original;
      return;
    }
    markVerified();
    setTimeout(() => (location.href = "index.html"), 1000);
  });

  codeInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") verifyBtn?.click();
  });

  resendBtn.addEventListener("click", async () => {
    resendBtn.disabled = true;
    const original = resendBtn.textContent;
    resendBtn.textContent = "Sending…";
    const { error } = await window.sb.auth.resend({ type: "signup", email });
    resendBtn.textContent = error ? "Couldn't resend — try again" : "Code resent ✓";
    setTimeout(() => {
      resendBtn.disabled = false;
      resendBtn.textContent = original;
    }, 4000);
  });
}

// ---------------- Logout ----------------
async function handleLogout() {
  await window.sb.auth.signOut();
  location.href = "index.html";
}

// ---------------- Route guard for account/admin pages ----------------
async function requireAuth() {
  const {
    data: { session },
  } = await window.sb.auth.getSession();
  if (!session) {
    location.href = `login.html?redirect=${encodeURIComponent(location.pathname.split("/").pop())}`;
    return null;
  }
  return session;
}

async function requireAdmin() {
  const session = await requireAuth();
  if (!session) return null;
  const { data: profile } = await window.sb.from("profiles").select("*").eq("id", session.user.id).single();
  if (profile?.role !== "admin") {
    location.href = "index.html";
    return null;
  }
  return profile;
}
