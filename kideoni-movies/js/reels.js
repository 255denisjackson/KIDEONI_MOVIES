// js/reels.js — vertical swipe feed (reels are always free, but every play
// still goes through the same signed-URL + tracked-view pipeline as movies).
(async function initReels() {
  const feed = document.getElementById("reelsFeed");
  const {
    data: { session },
  } = await window.sb.auth.getSession();

  const { data: reels, error } = await window.sb
    .from("reels")
    .select("id, title, caption, thumbnail_url, related_movie_id, duration_seconds, is_published, view_count, like_count, created_at")
    .eq("is_published", true)
    .order("created_at", { ascending: false });

  if (error || !reels?.length) {
    console.error("KIDEONI reels query error:", error);
    feed.innerHTML = `<p class="muted center" style="padding-top:120px; padding-inline:20px;">
      ${error ? `Couldn't load reels: ${escapeHtml(error.message)}` : "No reels available yet."}
    </p>`;
    return;
  }

  const reelIds = reels.map((r) => r.id);

  // Which of these reels has the current viewer already liked / saved?
  let likedIds = new Set();
  let savedIds = new Set();
  if (session?.user) {
    const [{ data: myLikes }, { data: mySaves }] = await Promise.all([
      window.sb.from("likes").select("content_id").eq("user_id", session.user.id).eq("content_type", "reel").in("content_id", reelIds),
      window.sb.from("saved_items").select("content_id").eq("user_id", session.user.id).eq("content_type", "reel").in("content_id", reelIds),
    ]);
    likedIds = new Set((myLikes || []).map((l) => l.content_id));
    savedIds = new Set((mySaves || []).map((s) => s.content_id));
  }

  // Comment counts per reel (grouped client-side — comment volume per reel is small)
  const { data: allComments } = await window.sb
    .from("comments")
    .select("content_id")
    .eq("content_type", "reel")
    .eq("is_deleted", false)
    .in("content_id", reelIds);
  const commentCounts = {};
  (allComments || []).forEach((c) => {
    commentCounts[c.content_id] = (commentCounts[c.content_id] || 0) + 1;
  });

  feed.innerHTML = reels
    .map(
      (r, i) => `
    <div class="reel-slide" data-id="${r.id}" data-index="${i}">
      <video muted loop playsinline poster="${r.thumbnail_url || ""}"></video>
      <div class="reel-tap-hint"><div class="icon-circle">▶</div></div>
      <button class="reel-mute-btn" aria-label="Toggle sound" type="button">🔇</button>
      <div class="reel-actions">
        <button class="reel-action-btn like-btn ${likedIds.has(r.id) ? "liked" : ""}" data-id="${r.id}">
          <span class="icon-disc">${likedIds.has(r.id) ? "❤️" : "🤍"}</span>
          <span class="like-count">${r.like_count ?? 0}</span>
        </button>
        <button class="reel-action-btn comment-btn" data-id="${r.id}">
          <span class="icon-disc">💬</span>
          <span class="comment-count">${commentCounts[r.id] ?? 0}</span>
        </button>
        <button class="reel-action-btn share-btn" data-id="${r.id}" data-title="${escapeHtml(r.title)}">
          <span class="icon-disc">↗</span>
          <span>Share</span>
        </button>
        <button class="reel-action-btn save-btn ${savedIds.has(r.id) ? "saved" : ""}" data-id="${r.id}">
          <span class="icon-disc">${savedIds.has(r.id) ? "🔖" : "📑"}</span>
          <span>Save</span>
        </button>
      </div>
      <div class="reel-info">
        <strong>${escapeHtml(r.title)}</strong>
        ${r.caption ? `<span>${escapeHtml(r.caption)}</span>` : ""}
      </div>
    </div>`
    )
    .join("");

  const slides = Array.from(feed.querySelectorAll(".reel-slide"));
  const loaded = new Set();

  function setHint(hint, icon) {
    if (icon === null) {
      hint.classList.remove("show");
      return;
    }
    hint.querySelector(".icon-circle").textContent = icon;
    hint.classList.add("show");
  }

  async function activate(slide) {
    const id = slide.dataset.id;
    const video = slide.querySelector("video");
    const hint = slide.querySelector(".reel-tap-hint");

    if (!loaded.has(id)) {
      loaded.add(id);
      setHint(hint, "…"); // loading
      const ok = await loadProtectedVideo(video, "reel", id, (err) => {
        setHint(hint, "⚠");
        console.error("KIDEONI reel load error:", err);
      });
      if (ok === null) return; // load failed — hint already shows the error
    }

    try {
      await video.play();
    } catch {
      setHint(hint, "▶"); // autoplay blocked — invite a tap
    }
  }

  function pause(slide) {
    slide.querySelector("video")?.pause();
  }

  slides.forEach((slide) => {
    const video = slide.querySelector("video");
    const hint = slide.querySelector(".reel-tap-hint");
    const muteBtn = slide.querySelector(".reel-mute-btn");

    // Video state always drives the hint icon — this is the actual play/pause button.
    video.addEventListener("play", () => setHint(hint, null));
    video.addEventListener("pause", () => setHint(hint, "▶"));
    video.addEventListener("waiting", () => setHint(hint, "…"));
    video.addEventListener("playing", () => setHint(hint, null));

    slide.addEventListener("click", (e) => {
      if (e.target.closest(".reel-mute-btn")) return;
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    });

    muteBtn.textContent = video.muted ? "🔇" : "🔊";
    muteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      video.muted = !video.muted;
      muteBtn.textContent = video.muted ? "🔇" : "🔊";
    });

    // ---- Like ----
    const likeBtn = slide.querySelector(".like-btn");
    likeBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const {
        data: { session: liveSession },
      } = await window.sb.auth.getSession();
      if (!liveSession) {
        location.href = `login.html?redirect=reels.html`;
        return;
      }
      const id = likeBtn.dataset.id;
      const iconEl = likeBtn.querySelector(".icon-disc");
      const countEl = likeBtn.querySelector(".like-count");
      const isLiked = likeBtn.classList.contains("liked");
      const count = parseInt(countEl.textContent, 10) || 0;

      // optimistic UI
      likeBtn.classList.toggle("liked");
      iconEl.textContent = isLiked ? "🤍" : "❤️";
      countEl.textContent = Math.max(0, count + (isLiked ? -1 : 1));

      if (isLiked) {
        const { error } = await window.sb
          .from("likes")
          .delete()
          .eq("user_id", liveSession.user.id)
          .eq("content_type", "reel")
          .eq("content_id", id);
        if (error) {
          likeBtn.classList.add("liked");
          iconEl.textContent = "❤️";
          countEl.textContent = count;
        }
      } else {
        const { error } = await window.sb
          .from("likes")
          .insert({ user_id: liveSession.user.id, content_type: "reel", content_id: id });
        if (error) {
          likeBtn.classList.remove("liked");
          iconEl.textContent = "🤍";
          countEl.textContent = count;
        }
      }
    });

    // ---- Comment ----
    const commentBtn = slide.querySelector(".comment-btn");
    commentBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openComments(commentBtn.dataset.id, commentBtn.querySelector(".comment-count"));
    });

    // ---- Save ----
    const saveBtn = slide.querySelector(".save-btn");
    saveBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const {
        data: { session: liveSession },
      } = await window.sb.auth.getSession();
      if (!liveSession) {
        location.href = `login.html?redirect=reels.html`;
        return;
      }
      const id = saveBtn.dataset.id;
      const iconEl = saveBtn.querySelector(".icon-disc");
      const isSaved = saveBtn.classList.contains("saved");

      saveBtn.classList.toggle("saved");
      iconEl.textContent = isSaved ? "📑" : "🔖";

      if (isSaved) {
        const { error } = await window.sb
          .from("saved_items")
          .delete()
          .eq("user_id", liveSession.user.id)
          .eq("content_type", "reel")
          .eq("content_id", id);
        if (error) {
          saveBtn.classList.add("saved");
          iconEl.textContent = "🔖";
        }
      } else {
        const { error } = await window.sb
          .from("saved_items")
          .insert({ user_id: liveSession.user.id, content_type: "reel", content_id: id });
        if (error) {
          saveBtn.classList.remove("saved");
          iconEl.textContent = "📑";
        }
      }
    });

    // ---- Share to WhatsApp ----
    const shareBtn = slide.querySelector(".share-btn");
    shareBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = shareBtn.dataset.id;
      const title = shareBtn.dataset.title;
      const url = `${location.origin}${location.pathname}?open=${id}`;
      const text = `Check out "${title}" on KIDEONI Reels: ${url}`;
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
    });
  });

  // ---------------- Comments sheet ----------------
  const sheet = document.getElementById("commentsSheet");
  const backdrop = document.getElementById("sheetBackdrop");
  const listEl = document.getElementById("commentsList");
  const input = document.getElementById("commentInput");
  const sendBtn = document.getElementById("sendCommentBtn");
  let activeReelId = null;
  let activeCountEl = null;

  function closeComments() {
    sheet.classList.remove("open");
    backdrop.classList.remove("show");
    activeReelId = null;
    activeCountEl = null;
  }
  document.getElementById("closeCommentsBtn").addEventListener("click", closeComments);
  backdrop.addEventListener("click", closeComments);

  async function openComments(reelId, countEl) {
    activeReelId = reelId;
    activeCountEl = countEl;
    sheet.classList.add("open");
    backdrop.classList.add("show");
    listEl.innerHTML = `<p class="muted">Loading comments…</p>`;
    await refreshComments();
  }

  async function refreshComments() {
    const { data: comments, error } = await window.sb
      .from("comments")
      .select("id, body, created_at, user_id, profiles:user_id(full_name, email, is_verified, avatar_url)")
      .eq("content_type", "reel")
      .eq("content_id", activeReelId)
      .eq("is_deleted", false)
      .order("created_at", { ascending: false });

    if (error) {
      listEl.innerHTML = `<p class="muted">Couldn't load comments: ${escapeHtml(error.message)}</p>`;
      return;
    }
    if (!comments?.length) {
      listEl.innerHTML = `<p class="muted">No comments yet — be the first.</p>`;
      return;
    }
    listEl.innerHTML = comments
      .map((c) => {
        const name = c.profiles?.full_name || c.profiles?.email || "Someone";
        const tick = c.profiles?.is_verified
          ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;border-radius:50%;background:#3b8bf5;color:#fff;font-size:8px;margin-left:4px;">✓</span>`
          : "";
        return `
        <div class="comment-row">
          <strong>${escapeHtml(name)}${tick}</strong>
          <span>${escapeHtml(c.body)}</span>
          <div class="muted">${new Date(c.created_at).toLocaleString()}</div>
        </div>`;
      })
      .join("");
  }

  async function postComment() {
    const body = input.value.trim();
    if (!body || !activeReelId) return;
    const {
      data: { session: liveSession },
    } = await window.sb.auth.getSession();
    if (!liveSession) {
      location.href = `login.html?redirect=reels.html`;
      return;
    }
    sendBtn.disabled = true;
    const { error } = await window.sb
      .from("comments")
      .insert({ user_id: liveSession.user.id, content_type: "reel", content_id: activeReelId, body });
    sendBtn.disabled = false;
    if (error) {
      alert("Couldn't post comment: " + error.message);
      return;
    }
    input.value = "";
    if (activeCountEl) activeCountEl.textContent = (parseInt(activeCountEl.textContent, 10) || 0) + 1;
    await refreshComments();
  }

  sendBtn.addEventListener("click", postComment);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") postComment();
  });

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && entry.intersectionRatio > 0.6) {
          activate(entry.target);
        } else {
          pause(entry.target);
        }
      });
    },
    { root: feed, threshold: [0, 0.6, 1] }
  );
  slides.forEach((s) => observer.observe(s));

  // Deep link: ?open=<reel_id> scrolls straight to that reel
  const params = new URLSearchParams(location.search);
  const openId = params.get("open");
  if (openId) {
    const target = slides.find((s) => s.dataset.id === openId);
    target?.scrollIntoView({ block: "start" });
  }

  function escapeHtml(str = "") {
    return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
})();
