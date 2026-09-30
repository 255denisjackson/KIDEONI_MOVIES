// js/nav.js — shared across every page. Updates the nav's auth area and
// wires the mobile menu toggle. Requires supabaseClient.js loaded first.
(async function initNav() {
  const authSlot = document.getElementById("navAuthSlot");
  if (!authSlot) return;

  function renderSignedOut() {
    authSlot.innerHTML = `
      <a href="login.html" class="btn btn-ghost btn-sm">Sign in</a>
      <a href="signup.html" class="btn btn-primary btn-sm">Join now</a>
    `;
  }

  function renderSignedIn(user, profile) {
    const isAdmin = profile?.role === "admin";
    const initial = (user.email || "U").charAt(0).toUpperCase();
    const avatar = profile?.avatar_url
      ? `<img src="${profile.avatar_url}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;" alt="" />`
      : initial;
    const tick = profile?.is_verified
      ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:#3b8bf5;color:#fff;font-size:9px;margin-left:4px;vertical-align:middle;">✓</span>`
      : "";
    authSlot.innerHTML = `
      ${isAdmin ? `<a href="admin/index.html" class="btn btn-ghost btn-sm">Admin</a>` : ""}
      <a href="account.html" class="avatar-btn" title="${user.email}">${avatar}${tick}</a>
    `;
  }

  const {
    data: { session },
  } = await window.sb.auth.getSession();

  if (session?.user) {
    const { data: profile } = await window.sb
      .from("profiles")
      .select("role, avatar_url, is_verified")
      .eq("id", session.user.id)
      .single();
    renderSignedIn(session.user, profile);
  } else {
    renderSignedOut();
  }

  window.sb.auth.onAuthStateChange(async (_event, s) => {
    if (s?.user) {
      const { data: profile } = await window.sb
        .from("profiles")
        .select("role, avatar_url, is_verified")
        .eq("id", s.user.id)
        .single();
      renderSignedIn(s.user, profile);
    } else renderSignedOut();
  });

  const toggle = document.getElementById("navToggle");
  const links = document.getElementById("navLinks");
  if (toggle && links) {
    toggle.addEventListener("click", () => links.classList.toggle("open"));
  }
})();
