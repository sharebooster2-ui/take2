// Shared state of the entire app
const state = {
  user: null,
  page: "dashboard",
  events: [],
  registrations: [],
  payments: [],
  schedules: [],
  profile: null,
  adminTab: "payments",
  selectedCourt: null,
  selectedSlotDate: "",
  selectedSlotIds: [],
  currentSlots: [],
  courtReviews: [],
  canReview: false,
  myReview: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[char],
  );
const initials = (name) =>
  (name || "PB")
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
const money = (amount) =>
  `₱${Number(amount || 0).toLocaleString("en-PH", { minimumFractionDigits: Number(amount || 0) % 1 ? 2 : 0 })}`;
const dateText = (
  date,
  options = { month: "short", day: "numeric", year: "numeric" },
) => new Date(date).toLocaleDateString("en-PH", options);
const todayLabel = (date = new Date()) =>
  date
    .toLocaleDateString("en-PH", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    })
    .toUpperCase();
const dateInput = (date) => new Date(date).toISOString().slice(0, 10);
const statusPill = (status) =>
  `<span class="pill ${esc(status)}">${esc(status)}</span>`;
const confirmationPill = (status) => {
  const statuses = {
    fully_confirmed: ["confirmed", "Fully confirmed"],
    pending_approval: ["pending", "Pending approval"],
    payment_pending: ["pending", "Payment under review"],
    awaiting_payment: ["confirmed", "Confirmed"],
    cancelled: ["cancelled", "Cancelled"],
  };
  const [className, label] = statuses[status] || statuses.pending_approval;
  return `<span class="pill ${className}">${label}</span>`;
};
const clockText = (value) => {
  const [hour, minute] = String(value || "00:00")
    .slice(0, 5)
    .split(":")
    .map(Number);
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute || 0).padStart(2, "0")} ${suffix}`;
};
const timeRangeText = (start, end) =>
  `${clockText(start)} – ${clockText(end)}`;
const scheduleTimeText = (start, end) =>
  end ? timeRangeText(start, end) : clockText(start);
const isSuperAdmin = () =>
  Boolean(state.user?.isSuperAdmin || state.user?.is_super_admin);
const closingText = (value) => {
  const raw = String(value || "").slice(0, 5);
  const [hour, minute] = raw.split(":").map(Number);
  const minutes = hour * 60 + minute;
  return Number.isFinite(minutes) && minutes <= 21 * 60
    ? clockText(value)
    : "9:00 PM";
};
const closingInputValue = (value) => {
  const raw = String(value || "21:00").slice(0, 5);
  const [hour, minute] = raw.split(":").map(Number);
  return Number.isFinite(hour * 60 + minute) && hour * 60 + minute <= 21 * 60
    ? raw
    : "21:00";
};
const localDate = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

function removeSensitiveQueryParams() {
  const url = new URL(window.location.href);
  const sensitiveKeys = ["email", "password", "fullName", "phone"];
  const hadSensitiveQuery = sensitiveKeys.some((key) =>
    url.searchParams.has(key),
  );
  if (!hadSensitiveQuery) return;
  sensitiveKeys.forEach((key) => url.searchParams.delete(key));
  window.history.replaceState(
    {},
    document.title,
    `${url.pathname}${url.search}${url.hash}`,
  );
}
removeSensitiveQueryParams();

const courtRules = (court) => {
  try {
    return Array.isArray(court.rate_rules)
      ? court.rate_rules
      : JSON.parse(court.rate_rules || "[]");
  } catch {
    return [];
  }
};
const courtAmenities = (court) => {
  try {
    return Array.isArray(court.amenities)
      ? court.amenities
      : JSON.parse(court.amenities || "[]");
  } catch {
    return [];
  }
};
const courtPriceRange = (court) => {
  const prices = courtRules(court)
    .map((rule) => Number(rule.price))
    .filter(Number.isFinite);
  if (!prices.length) return money(court.fee);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  return low === high ? money(low) : `${money(low)}–${money(high)}`;
};

function applyBranding(root = document.body) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    node.nodeValue = node.nodeValue
      .replaceAll("RallyPoint", "PickleBalls")
      .replaceAll("RALLYPOINT", "PICKLEBALLS");
  }
}
applyBranding();
new MutationObserver(() => applyBranding()).observe(document.body, {
  childList: true,
  subtree: true,
});

// A unified way of calling the server's endpoints.
async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

// Updating the number of active players on the login screen.
async function refreshPlayerCount() {
  const countElement = $("#player-count");
  if (!countElement) return;
  try {
    const data = await api("/api/club-stats");
    countElement.textContent = `${Number(data.players || 0).toLocaleString("en-PH")} players`;
  } catch (error) {
    console.error("Could not load live player count:", error);
  }
}

refreshPlayerCount();
setInterval(refreshPlayerCount, 15000);

// Displays a small message at the bottom of the screen.
function toast(message, type = "success") {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  $("#toast-stack").append(item);
  setTimeout(() => item.remove(), 3800);
}

// Indicates that a button is currently processing an action.
function setBusy(button, busy, label = "Working…") {
  if (!button) return;
  if (busy) {
    button.dataset.original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span>${label}`;
  } else {
    button.disabled = false;
    button.innerHTML = button.dataset.original || button.innerHTML;
  }
}

// Nagpapalit ng login, register, reset, o admin na screen
function switchAuth(tab) {
  $$(".auth-tab").forEach((button) =>
    button.classList.toggle("active", button.dataset.authTab === tab),
  );
  $$(".auth-menu-item").forEach((button) =>
    button.classList.toggle("active", button.dataset.authTab === tab),
  );
  $$(".auth-panel").forEach((panel) =>
    panel.classList.toggle("active", panel.id === `${tab}-panel`),
  );
  $(".auth-tabs").classList.toggle(
    "hidden",
    tab.startsWith("admin") || tab === "forgot" || tab === "reset",
  );
}

// Processes login and member or admin account creation.
async function auth(event, type) {
  event.preventDefault();
  const button = event.target.querySelector("button[type=submit]");
  const endpoint = type === "admin" ? "admin-login" : type;
  const registering = type === "register" || type === "admin-register";
  setBusy(button, true, registering ? "Creating…" : "Signing in…");
  try {
    const payload = Object.fromEntries(new FormData(event.target));
    const data = await api(`/api/auth/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (data.pendingApproval) {
      switchAuth(type === "admin-register" ? "admin" : "login");
      toast(data.message, "success");
      return;
    }
    state.user = data.user;
    await bootApp();
    toast(
      type === "admin"
        ? "Welcome to the admin panel."
        : type === "admin-register"
          ? "Admin access request submitted."
          : type === "login"
            ? "Welcome back to PickleBalls."
            : "Your PickleBalls account is ready.",
    );
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

// naga pangayo ug link para ma reset at nakalimtan nimo nga password
async function forgotPassword(event) {
  event.preventDefault();
  const button = event.target.querySelector("button[type=submit]");
  setBusy(button, true, "Sending…");
  try {
    const data = await api("/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(event.target))),
    });
    toast(data.message || "Check your email for a reset link.", "success");
    event.target.reset();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

// gina save ang bagong password sa reset link
async function resetPassword(event) {
  event.preventDefault();
  const form = event.target;
  const values = Object.fromEntries(new FormData(form));
  if (values.password !== values.confirmPassword) {
    toast("The passwords do not match.", "error");
    return;
  }
  const button = form.querySelector("button[type=submit]");
  setBusy(button, true, "Updating…");
  try {
    const data = await api("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: values.token, password: values.password }),
    });
    history.replaceState({}, "", "/");
    switchAuth("login");
    form.reset();
    toast(data.message || "Your password has been reset.", "success");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

// Initializes the main app after a successful login.
async function bootApp() {
  $("#auth-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  updateUserChrome();
  await navigate(state.page || "dashboard");
}

function updateUserChrome() {
  const name = state.user?.full_name || state.user?.fullName || "Rally player";
  const initialsText = initials(name);
  $("#sidebar-name").textContent = name;
  $("#sidebar-role").textContent =
    state.user?.role === "admin" ? "Administrator" : "Member";
  $("#sidebar-avatar").textContent = initialsText;
  $("#top-avatar").textContent = initialsText;
  $("#admin-nav").classList.toggle("hidden", state.user?.role !== "admin");
  $("#schedule-nav").classList.toggle("hidden", state.user?.role === "admin");
}

// Switches between pages and fetches the appropriate data for each page.
async function navigate(page) {
  state.page = page;
  $$(".nav-item").forEach((item) =>
    item.classList.toggle("active", item.dataset.page === page),
  );
  $("#breadcrumb-title").textContent =
    page === "payment-history"
      ? "Payment History"
      : page.replace("-", " ").replace(/\b\w/g, (char) => char.toUpperCase());
  $(".sidebar")?.classList.remove("open");
  $("#page-container").innerHTML =
    `<div class="loading"><span class="spinner"></span>Loading PickleBalls…</div>`;
  const pages = {
    dashboard: renderDashboard,
    profile: renderProfile,
    events: renderEvents,
    registrations: renderRegistrations,
    schedule: renderSchedule,
    payments: renderPayments,
    "payment-history": renderPaymentHistory,
    notifications: renderNotifications,
    settings: renderSettings,
    admin: openAdmin,
  };
  try {
    await (pages[page] || renderDashboard)();
  } catch (error) {
    $("#page-container").innerHTML =
      `<div class="page"><div class="empty-state"><div>◌</div><strong>Could not load this page</strong><p>${esc(error.message)}</p></div></div>`;
    toast(error.message, "error");
  }
  if (window.innerWidth <= 720) $(".sidebar")?.classList.remove("open");
}

// Renders the dashboard and upcoming bookings.
async function renderDashboard() {
  const [dashboard, events, registrations, notifications] = await Promise.all([
    api("/api/dashboard"),
    api("/api/events"),
    api("/api/registrations"),
    api("/api/notifications"),
  ]);
  state.events = events.events;
  state.registrations = registrations.registrations;
  const next = dashboard.nextEvent;
  $("#event-count").textContent = events.events.length;
  $("#notification-count").textContent = dashboard.unreadNotifications;
  $("#top-notification-badge").classList.toggle(
    "hidden",
    !dashboard.unreadNotifications,
  );
  $("#page-container").innerHTML = `<div class="page">
    <div class="page-heading"><div><p class="eyebrow">${todayLabel()}</p><h1>Good morning, ${esc((state.user.full_name || state.user.fullName || "player").split(" ")[0])}.</h1><p>Find an open court and reserve your next game.</p></div><div class="heading-actions"><span class="date-chip">◷ This week</span><button class="button lime small" data-page="events">Find a court ↗</button></div></div>
    <div class="stats-grid"><div class="stat-card"><div class="stat-top"><span>My registrations</span><span class="stat-icon">▤</span></div><div class="stat-value">${dashboard.registrations}</div><div class="stat-help"><strong>Active</strong> events on your calendar</div></div>
      <div class="stat-card"><div class="stat-top"><span>Verified payments</span><span class="stat-icon">₱</span></div><div class="stat-value">${dashboard.verifiedPayments}</div><div class="stat-help">Keep your spots confirmed</div></div>
      <div class="stat-card"><div class="stat-top"><span>Unread updates</span><span class="stat-icon">◌</span></div><div class="stat-value">${dashboard.unreadNotifications}</div><div class="stat-help">From PickleBalls admins</div></div></div>
    <div class="section-heading"><div><p class="eyebrow">BOOK YOUR NEXT GAME</p><h2 class="section-title">Courts near you</h2><p class="section-subtitle">Choose a court, check the details, and save your playing time.</p></div><button class="text-link" data-page="events">View all courts →</button></div>
    <div class="court-grid">${events.events.slice(0, 3).map(courtCard).join("") || `<div class="card empty-courts"><div class="empty-state"><div>⌖</div><strong>No courts available yet</strong><p>New courts will appear here when they are published.</p></div></div>`}</div>
     <div class="dashboard-grid"><div class="card"><div class="card-title"><h3>Next on your calendar</h3><button class="text-link" data-page="registrations">View all →</button></div>${next ? `<div class="next-event"><span class="event-status">${confirmationPill(next.confirmation_status || (next.status === "confirmed" ? "awaiting_payment" : "pending_approval"))}</span><p class="eyebrow">UPCOMING EVENT</p><h3>${esc(next.name)}</h3><div class="event-meta"><span>◷ ${dateText(next.event_date)}${next.slot_times ? ` · ${esc(next.slot_times).replaceAll("\\n", "<br>")}` : ""}</span><span>⌖ ${esc(next.location)}</span></div></div>` : `<div class="empty-state"><div>✦</div><strong>No games booked yet</strong><p>Find an event and save your first spot.</p><button class="button primary small" data-page="events" style="margin-top:15px">Browse events</button></div>`}</div>
      <div class="card"><div class="card-title"><h3>Recent activity</h3><button class="text-link" data-page="notifications">See updates →</button></div><div class="activity-list">${
        notifications.notifications
          .slice(0, 3)
          .map(
            (notification) =>
              `<div class="activity"><div class="activity-dot">${notification.type === "success" ? "✓" : "◌"}</div><div><p>${esc(notification.title)}</p><small>${esc(notification.message).slice(0, 72)}${notification.message.length > 72 ? "…" : ""}</small></div></div>`,
          )
          .join("") ||
        `<div class="empty-state"><strong>All quiet here</strong><p>Your updates will show up here.</p></div>`
      }</div></div></div>
  </div>`;
}

// Renders a list of available courts.
async function renderEvents() {
  const data = await api("/api/events");
  state.events = data.events;
  $("#page-container").innerHTML =
    `<div class="page"><div class="page-heading"><div><p class="eyebrow">FIND YOUR NEXT COURT</p><h1>Available courts</h1><p>Browse open playing spaces, see the details, and request your spot.</p></div><div class="heading-actions"><span class="date-chip">${data.events.length} available</span></div></div>
  <div class="filter-row"><select id="category-filter"><option value="">All categories</option>${[...new Set(data.events.map((event) => event.category))].map((category) => `<option>${esc(category)}</option>`).join("")}</select><input id="event-search" placeholder="Search courts or locations"></div><div class="court-grid court-grid-page" id="event-grid">${data.events.map(courtCard).join("")}</div></div>`;
  $("#category-filter").addEventListener("change", filterEvents);
  $("#event-search").addEventListener("input", filterEvents);
}

// Gumagawa ng card para sa isang court
function courtCard(event, index = state.events.indexOf(event)) {
  const meta = [
    {
      surface: "Sport Court",
      type: "Indoor",
       hours: "8:00 AM–9:00 PM",
      amenities: ["Parking", "Restrooms", "Lights"],
    },
    {
      surface: "Pickleball Court",
      type: "Outdoor",
       hours: "7:00 AM–9:00 PM",
      amenities: ["Seating", "Lights", "Parking"],
    },
    {
      surface: "Sport Court",
      type: "Indoor",
       hours: "6:00 AM–9:00 PM",
      amenities: ["Restrooms", "Food & coffee", "Lights"],
    },
  ][Math.abs(index) % 3];
  const full = Number(event.available_slots) < 1;
  const amenities = courtAmenities(event);
  const displayAmenities = amenities.length ? amenities : meta.amenities;
  const type = event.category || meta.type;
  const surface = event.surface || meta.surface;
  const opening = event.opening_time
    ? clockText(event.opening_time)
    : meta.hours.split("–")[0];
  const closing = event.closing_time
    ? closingText(event.closing_time)
    : "9:00 PM";
  const image = event.image_url
    ? `<img src="${esc(event.image_url)}" alt="${esc(event.name)} court" loading="lazy">`
    : "";
  const reviews = Number(event.review_count || 0);
  const rating = reviews
    ? `★ ${Number(event.rating || 0).toFixed(1)} <small>(${reviews})</small>`
    : "No ratings yet";
  const bookingLabel = full
    ? `<button class="button ghost small view-court" data-id="${event.id}">View details</button>`
    : `<button class="button primary small view-court" data-id="${event.id}">Choose your slot ↗</button>`;
  return `<article class="court-card event-card" data-category="${esc(event.category)}" data-search="${esc(`${event.name} ${event.location}`.toLowerCase())}">
    <div class="court-card-media court-media-${Math.abs(index) % 3}">${image}
      <div class="court-card-badges"><span>${esc(type)}</span><span>${esc(surface)}</span></div>
      <span class="court-media-arrow">↗</span>
    </div>
    <div class="court-card-body">
      <div class="court-card-heading"><div><h3>${esc(event.name)}</h3><p class="court-location">⌖ ${esc(event.location)}</p></div><span class="court-rating ${reviews ? "" : "unrated"}">${rating}</span></div>
      <div class="court-info"><span>◷ ${esc(opening)}–${esc(closing)}</span><span>${esc(courtPriceRange(event))} <small>/hr</small></span></div>
      <div class="court-amenities">${displayAmenities
        .slice(0, 4)
        .map((amenity) => `<span>${esc(amenity)}</span>`)
        .join("")}</div>
      <div class="court-card-footer"><span class="court-category">${esc(event.category)}</span>${bookingLabel}</div>
    </div>
  </article>`;
}

// Displays court details and available time slots.
async function showCourtDetails(courtId, date = localDate()) {
  state.page = "court-detail";
  state.selectedCourt = null;
  state.selectedSlotDate = date;
  state.selectedSlotIds = [];
  state.currentSlots = [];
  $("#page-container").innerHTML =
    `<div class="loading"><span class="spinner"></span>Loading court details…</div>`;
  try {
    const [courtResponse, slotResponse, reviewResponse] = await Promise.all([
      api(`/api/courts/${courtId}`),
      api(`/api/slots?courtId=${courtId}&date=${encodeURIComponent(date)}`),
      api(`/api/courts/${courtId}/reviews`),
    ]);
    state.selectedCourt = courtResponse.court;
    state.currentSlots = slotResponse.slots;
    state.courtReviews = reviewResponse.reviews;
    state.canReview = reviewResponse.canReview;
    state.myReview = reviewResponse.myReview;
    renderCourtDetails();
  } catch (error) {
    $("#page-container").innerHTML =
      `<div class="page"><div class="empty-state"><div>◌</div><strong>Could not load this court</strong><p>${esc(error.message)}</p><button class="button ghost small" data-page="events">Back to courts</button></div></div>`;
    toast(error.message, "error");
  }
}

// Renders court details, reviews, and the slot picker.
function renderCourtDetails() {
  const court = state.selectedCourt;
  const slots = state.currentSlots;
  const rules = courtRules(court);
  const amenities = courtAmenities(court);
  const opening = court.opening_time
    ? clockText(court.opening_time)
    : "7:00 AM";
  const closing = closingText(court.closing_time);
  const image = court.image_url
    ? `<img src="${esc(court.image_url)}" alt="${esc(court.name)} court">`
    : "";
  const today = localDate();
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
  const slotCells = slots
    .map((slot) => {
      const startMinutes =
        Number(String(slot.start_time).slice(0, 2)) * 60 +
        Number(String(slot.start_time).slice(3, 5));
      const past =
        state.selectedSlotDate < today ||
        (state.selectedSlotDate === today && startMinutes <= nowMinutes);
      const availability = past ? "past" : slot.availability;
      const selected = state.selectedSlotIds.includes(slot.id);
      const disabled = availability !== "open";
      const slotState =
        availability === "open" || selected
          ? "OPEN"
          : availability === "booked"
            ? "BOOKED"
            : availability === "past"
              ? "PAST"
              : "UNAVAILABLE";
      return `<button type="button" class="slot-cell ${availability} ${selected ? "selected" : ""}" data-slot-id="${slot.id}" ${disabled ? "disabled" : ""}><span class="slot-time">${esc(timeRangeText(slot.start_time, slot.end_time))}</span><span class="slot-state">${slotState}</span>${availability === "open" || selected ? `<strong>${money(slot.price)}</strong>` : ""}</button>`;
    })
    .join("");
  const selectedSlots = slots.filter((slot) =>
    state.selectedSlotIds.includes(slot.id),
  );
  const total = selectedSlots.reduce(
    (sum, slot) => sum + Number(slot.price),
    0,
  );
  const reviewCount = Number(court.review_count || 0);
  const ratingLabel = reviewCount
    ? `★ ${Number(court.rating || 0).toFixed(1)} <span>(${reviewCount} reviews)</span>`
    : `<span class="unrated">No ratings yet</span>`;
  const reviewForm = state.canReview
    ? `<form id="court-review-form" class="review-form">
    <div class="review-form-heading"><div><strong>${state.myReview ? "Update your rating" : "Rate this court"}</strong><small>Only members with an approved booking can review.</small></div><select required name="rating" aria-label="Your rating">${[5, 4, 3, 2, 1].map((value) => `<option value="${value}" ${Number(state.myReview?.rating) === value ? "selected" : ""}>${value} ${value === 1 ? "star" : "stars"}</option>`).join("")}</select></div>
    <textarea name="comment" maxlength="1000" placeholder="Tell other players about the court (optional).">${esc(state.myReview?.comment || "")}</textarea>
    <button class="button primary small" type="submit">${state.myReview ? "Update review" : "Submit rating"} ↗</button>
  </form>`
    : `<div class="review-eligibility">${state.user?.role === "member" ? "Book this court and wait for approval before rating it." : "Sign in as a member with an approved booking to rate this court."}</div>`;
  const reviewList = state.courtReviews.length
    ? state.courtReviews
        .map(
          (review) =>
            `<article class="court-review"><div class="review-avatar">${initials(review.full_name)}</div><div class="review-copy"><div class="review-meta"><strong>${esc(review.full_name)}</strong><span>${"★".repeat(Number(review.rating))}${"☆".repeat(5 - Number(review.rating))}</span></div><p>${review.comment ? esc(review.comment) : "No written comment."}</p><small>${dateText(review.updated_at || review.created_at, { month: "short", day: "numeric", year: "numeric" })}${review.updated_at && review.created_at !== review.updated_at ? " · Edited" : ""}</small></div></article>`,
        )
        .join("")
    : `<div class="empty-review-state">No player ratings yet. Be the first approved player to share your experience.</div>`;
  $("#page-container").innerHTML = `<div class="page court-detail-page">
    <button class="back-link" data-page="events">← Back to courts</button>
    <div class="court-detail-hero"><div class="court-detail-image court-media-0">${image}</div><div><div class="court-card-badges"><span>${esc(court.category || "Indoor")}</span><span>${esc(court.surface || "Sport Court")}</span></div><p class="eyebrow">COURT DETAILS</p><h1>${esc(court.name)}</h1><p class="court-detail-location">⌖ ${esc(court.location)}</p><div class="detail-rating">${ratingLabel}</div></div></div>
    <div class="court-detail-layout"><div>
      <section class="card slot-picker"><div class="detail-section-heading"><div><p class="eyebrow">BOOK YOUR PLAYING TIME</p><h2>Choose your slots</h2><p>Select one or more open hours for this court.</p></div><label class="date-picker"><span>Choose a date</span><input id="slot-date" type="date" value="${esc(state.selectedSlotDate)}"></label></div>
      <div class="slot-board"><div class="slot-board-header"><span>Time</span><strong>${esc(court.name)}</strong><small>${esc(court.category || "Court")}</small></div>${slotCells || `<div class="empty-slot-state">No slots are available for this date.</div>`}</div>
      <div class="slot-legend"><span><i class="legend-dot open"></i>Open</span><span><i class="legend-dot selected"></i>Selected</span><span><i class="legend-dot booked"></i>Booked</span><span><i class="legend-dot past"></i>Past</span></div>
       <div class="slot-helper">Tap open time slots to build your booking. Selected slots will be added to the summary below.</div></section>
      <section class="card court-info-detail"><div class="detail-section-heading"><div><p class="eyebrow">ABOUT THIS COURT</p><h2>Court details</h2></div></div><div class="detail-grid"><div><span>Surface</span><strong>${esc(court.surface || "Sport Court")}</strong></div><div><span>Hours</span><strong>${esc(opening)}–${esc(closing)}</strong></div><div><span>Contact</span><strong>${esc(court.contact || "Contact admin")}</strong></div><div><span>Location</span><strong>${esc(court.location)}</strong></div></div><div class="rate-list"><span>Rates by time</span>${rules.map((rule) => `<div><strong>${esc(clockText(rule.start))} – ${esc(clockText(rule.end))}: ${money(rule.price)} /hr</strong><small>Every day</small></div>`).join("") || `<div><strong>${money(court.fee)} /hr</strong><small>Standard rate</small></div>`}</div><div class="amenity-list">${(amenities.length ? amenities : ["Parking", "Restrooms", "Lights"]).map((amenity) => `<span>${esc(amenity)}</span>`).join("")}</div></section>
    </div><aside class="card booking-summary"><p class="eyebrow">YOUR BOOKING</p><h2>Selected slots</h2><div id="selected-slot-list">${selectedSlots.length ? selectedSlots.map((slot) => `<div class="selected-slot-line"><span>${esc(timeRangeText(slot.start_time, slot.end_time))}</span><strong>${money(slot.price)}</strong></div>`).join("") : `<div class="summary-empty">No slots selected yet.</div>`}</div><div class="summary-total"><span>Total</span><strong id="slot-total">${money(total)}</strong></div><button id="confirm-slot-booking" class="button primary full" ${selectedSlots.length ? "" : "disabled"}>Request booking ↗</button><small class="summary-note">Your request will be reviewed by the court admin.</small></aside></div>
   </div><section class="card court-reviews"><div class="detail-section-heading"><div><p class="eyebrow">PLAYER FEEDBACK</p><h2>Ratings & reviews</h2><p>Ratings come from members who have an approved booking.</p></div><strong class="review-summary">${reviewCount ? `${Number(court.rating || 0).toFixed(1)} / 5` : "New court"}</strong></div>${reviewForm}<div class="review-list">${reviewList}</div></section>
   </div>`;
  const reviewFormElement = $("#court-review-form");
  reviewFormElement?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.target.querySelector("button[type=submit]");
    setBusy(button, true, "Saving…");
    try {
      await api(`/api/courts/${court.id}/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(event.target))),
      });
      toast(
        state.myReview
          ? "Your review was updated."
          : "Thanks for rating this court.",
      );
      await showCourtDetails(court.id, state.selectedSlotDate);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(button, false);
    }
  });
}

// Updates the summary of the selected date, time, and amount.
function updateBookingSummary() {
  const list = $("#selected-slot-list");
  const totalElement = $("#slot-total");
  const confirmButton = $("#confirm-slot-booking");
  if (!list || !totalElement || !confirmButton) return;
  const selected = state.currentSlots.filter((slot) =>
    state.selectedSlotIds.includes(slot.id),
  );
  list.innerHTML = selected.length
    ? selected
        .map(
          (slot) =>
            `<div class="selected-slot-line"><span>${esc(timeRangeText(slot.start_time, slot.end_time))}</span><strong>${money(slot.price)}</strong></div>`,
        )
        .join("")
    : `<div class="summary-empty">No slots selected yet.</div>`;
  totalElement.textContent = money(
    selected.reduce((sum, slot) => sum + Number(slot.price), 0),
  );
  confirmButton.disabled = !selected.length;
}

async function openPaymentPage(registrationId = null) {
  await navigate("payments");
  const select = $("#payment-form select");
  if (!select || !registrationId) return;
  select.value = String(registrationId);
  select.dispatchEvent(new Event("change"));
}

function eventCard(event) {
  const colors = {
    Tournament: "",
    Clinic: "blue",
    Community: "orange",
    Social: "",
  };
  const full = Number(event.available_slots) < 1;
  return `<article class="event-card" data-category="${esc(event.category)}" data-search="${esc(`${event.name} ${event.location}`.toLowerCase())}"><div class="event-card-top ${colors[event.category] || ""}"><span class="category">${esc(event.category)}</span><div class="event-date-large">${dateText(event.event_date, { month: "short", day: "numeric" })}</div></div><div class="event-card-body"><h3>${esc(event.name)}</h3><p>${esc(event.description)}</p><div class="event-details"><span>◷ ${dateText(event.event_date, { weekday: "short", hour: "numeric", minute: "2-digit" })}</span><span>⌖ ${esc(event.location)}</span></div><div class="event-bottom"><div><div class="fee">${money(event.fee)} <small>entry</small></div><div class="slots">${full ? "Sold out" : `${event.available_slots} spots left`}</div></div>${event.registered ? statusPill(event.registration_status || "pending") : `<button class="button ${full ? "ghost" : "primary"} small register-event" data-id="${event.id}" ${full ? "disabled" : ""}>${full ? "Full" : "Request spot"} ${full ? "" : "↗"}</button>`}</div></div></article>`;
}

// Filters court cards by category and search term.
function filterEvents() {
  const category = $("#category-filter").value.toLowerCase();
  const search = $("#event-search").value.toLowerCase();
  $$(".event-card").forEach((card) =>
    card.classList.toggle(
      "hidden",
      (category && card.dataset.category.toLowerCase() !== category) ||
        (search && !card.dataset.search.includes(search)),
    ),
  );
}

// Renders the current user’s bookings.
async function renderRegistrations() {
  const data = await api("/api/registrations");
  state.registrations = data.registrations;
  $("#page-container").innerHTML =
     `<div class="page"><div class="page-heading"><div><p class="eyebrow">YOUR COURT TIME</p><h1>My bookings</h1><p>Every court you’ve requested, all in one place.</p></div><button class="button lime small" data-page="events">Browse courts ↗</button></div><div class="card table-card"><table class="data-table"><thead><tr><th>Court</th><th>Date & location</th><th>Booked slots</th><th>Booking</th><th>Payment</th><th>Actions</th></tr></thead><tbody>${data.registrations.map((item) => `<tr><td><strong>${esc(item.name)}</strong><br><span style="font-size:10px;color:#9aa69f">${esc(item.category)}</span></td><td>${dateText(item.booking_date || item.event_date)}<br><span style="font-size:10px;color:#9aa69f">${esc(item.location)}</span></td><td>${item.slot_times ? `<span class="booking-slot-times">${esc(item.slot_times).replaceAll("\\n", "<br>")}</span>` : "Court request"}</td><td>${confirmationPill(item.confirmation_status)}</td><td>${item.payment_status ? statusPill(item.payment_status) : `<span class="pill draft">${item.status === "confirmed" ? "Not submitted" : "Awaiting approval"}</span>`}</td><td class="action-cell">${item.status !== "cancelled" && item.status === "confirmed" && (!item.payment_status || item.payment_status === "rejected") ? `<button class="button ghost small pay-for-event" data-id="${item.id}">Pay now</button>` : ""}${item.status !== "cancelled" ? `<button class="button danger small cancel-booking" data-id="${item.id}">Cancel</button>` : `<span class="pill cancelled">Cancelled</span>`}</td></tr>`).join("") || `<tr><td colspan="6"><div class="empty-state"><strong>No bookings yet</strong><p>Browse courts to request your next spot.</p></div></td></tr>`}</tbody></table></div></div>`;
}

// Renders the manual schedule and automatic court bookings.
async function renderSchedule() {
  const data = await api("/api/schedules");
  state.schedules = data.schedules;
  $("#page-container").innerHTML =
     `<div class="page"><div class="page-heading"><div><p class="eyebrow">PLAN YOUR COURT TIME</p><h1>My schedule</h1><p>Saved schedules are fully confirmed. Court bookings become fully confirmed after payment verification.</p></div></div>
    <div class="payment-layout schedule-layout"><div class="card"><div class="card-title"><h3>Add a playing schedule</h3><span class="stat-icon">◷</span></div><form id="schedule-form" class="modal-form"><input type="hidden" name="id"><label class="full-width">Title<input required name="title" placeholder="Saturday morning games"></label><label>Date<input required type="date" name="scheduleDate"></label><label>Start time<input required type="time" name="startTime"></label><label>End time (optional)<input type="time" name="endTime"></label><label class="full-width">Location<input required name="location" placeholder="BGC Pickleball Club"></label><label class="full-width">Notes (optional)<textarea name="notes" placeholder="Players, court number, or anything else"></textarea></label><div class="modal-actions"><button type="button" class="button ghost hidden" id="cancel-schedule-edit">Cancel edit</button><button class="button primary" type="submit">Save schedule ↗</button></div></form></div>
     <div class="card table-card"><div class="card-title"><h3>Upcoming play times</h3><span class="pill confirmed">${data.schedules.length} saved</span></div><table class="data-table"><thead><tr><th>Schedule</th><th>Date & time</th><th>Location</th><th>Notes</th><th></th></tr></thead><tbody>${data.schedules.map((item) => `<tr class="${item.completed ? "completed-row" : ""}"><td><strong>${esc(item.title)}</strong>${item.source === "booking" ? `<br><span class="schedule-source">Court booking</span>` : ""}${item.completed ? `<br><span class="pill completed">Completed</span>` : ""}</td><td>${dateText(item.schedule_date)}<br><small>${esc(scheduleTimeText(item.start_time, item.end_time))}</small></td><td>${esc(item.location)}</td><td>${esc(item.notes || "—")} ${confirmationPill(item.confirmation_status)}</td><td>${item.source === "booking" ? "—" : `<button class="button ghost small edit-schedule" data-id="${item.id}">Edit</button> <button class="button danger small delete-schedule" data-id="${item.id}">Delete</button>`}</td></tr>`).join("") || `<tr><td colspan="5"><div class="empty-state"><strong>No playing schedules yet</strong><p>Add your next court time on the left.</p></div></td></tr>`}</tbody></table></div></div></div>`;
  $("#schedule-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const id = form.elements.id.value;
    const button = form.querySelector("button[type=submit]");
    setBusy(button, true, "Saving…");
    try {
      await api(id ? `/api/schedules/${id}` : "/api/schedules", {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      toast(id ? "Schedule updated." : "Schedule saved.");
      await renderSchedule();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(button, false);
    }
  });
  $("#cancel-schedule-edit").addEventListener("click", () => renderSchedule());
}

// Renders the payment form and payment methods.
async function renderPayments() {
  const [registrations, payments] = await Promise.all([
    api("/api/registrations"),
    api("/api/payments"),
  ]);
  state.registrations = registrations.registrations;
  const payable = registrations.registrations.filter(
    (item) =>
      item.status === "confirmed" &&
      !["verified", "pending"].includes(item.payment_status),
  );
  const awaitingApproval = registrations.registrations.filter(
    (item) => item.status === "pending",
  );
  $("#page-container").innerHTML =
     `<div class="page"><div class="page-heading"><div><p class="eyebrow">SECURE YOUR SPOT</p><h1>Payments</h1><p>Pay via GCash, then send your proof for review.</p></div></div><div class="payment-layout"><div class="card"><div class="card-title"><h3>How to pay with GCash</h3><span class="stat-icon">₱</span></div><div class="step-list"><div class="step"><span class="step-number">1</span><div><strong>Open GCash</strong><p>Open the GCash app on your phone.</p></div></div><div class="step"><span class="step-number">2</span><div><strong>Send the exact fee</strong><p>Send your registration fee to <strong>09484673611</strong>.</p></div></div><div class="step"><span class="step-number">3</span><div><strong>Save your receipt</strong><p>Take a screenshot of the successful payment.</p></div></div><div class="step"><span class="step-number">4</span><div><strong>Send it to the admin</strong><p>Message the screenshot through Facebook, then submit it here.</p><a class="fb-link" href="https://www.facebook.com/joshuaapostol2006" target="_blank" rel="noreferrer">Open Facebook ↗</a></div></div></div></div><div class="card"><div class="card-title"><h3>Submit payment proof</h3><span class="pill pending">Admin review</span></div><div class="notice">Proof is usually reviewed within 24 hours. Your spot is confirmed after verification.</div>${payable.length ? `<form id="payment-form" class="payment-form"><label class="field-label full-width">Event<select required name="registrationId">${payable.map((item) => `<option value="${item.id}">${esc(item.name)} — ${money(item.fee)}</option>`).join("")}</select></label><label class="field-label">Amount<input required type="number" step="0.01" name="amount" id="payment-amount" placeholder="0.00"></label><label class="field-label">Payment date<input required type="date" name="paymentDate" value="${dateInput(new Date())}"></label><label class="field-label full-width">Screenshot / proof<div class="upload-box"><input required type="file" name="proof" accept="image/png,image/jpeg,image/webp"><small>JPG, PNG or WEBP · max 5MB</small></div></label><label class="field-label full-width">Notes (optional)<textarea name="notes" placeholder="Anything the admin should know?"></textarea></label><button class="button primary full-width" type="submit">Submit for review ↗</button></form>` : `<div class="empty-state"><div>${awaitingApproval.length ? "◷" : "✓"}</div><strong>${awaitingApproval.length ? "Waiting for admin approval" : "No payment needed right now"}</strong><p>${awaitingApproval.length ? "Your booking request is still being reviewed. The payment form will appear here after approval." : "Register for an event first, or check your payment history."}</p></div>`}</div></div></div>`;
  const select = $("#payment-form select");
  if (select) {
    const selected = payable[0];
    $("#payment-amount").value = selected.fee;
    select.addEventListener("change", () => {
      $("#payment-amount").value = payable.find(
        (item) => item.id === Number(select.value),
      ).fee;
    });
  }
  $("#payment-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.target.querySelector("button[type=submit]");
    setBusy(button, true, "Submitting…");
    try {
      await api("/api/payments", {
        method: "POST",
        body: new FormData(event.target),
      });
      toast(
        "Payment proof submitted successfully. It is now pending admin review.",
      );
      await renderPaymentHistory();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(button, false);
    }
  });
}

// Renders the history of submitted payment proofs.
async function renderPaymentHistory() {
  const data = await api("/api/payments");
  state.payments = data.payments;
  $("#page-container").innerHTML =
    `<div class="page"><div class="page-heading"><div><p class="eyebrow">YOUR TRANSACTIONS</p><h1>Payment history</h1><p>Track every submitted proof and admin decision.</p></div><button class="button lime small" data-page="payments">Submit proof ↗</button></div><div class="card table-card"><table class="data-table"><thead><tr><th>Event</th><th>Submitted</th><th>Amount</th><th>Reference</th><th>Proof</th><th>Status</th><th>Note</th></tr></thead><tbody>${data.payments.map((item) => `<tr><td><strong>${esc(item.event_name)}</strong></td><td>${dateText(item.submitted_at)}</td><td>${money(item.amount)}</td><td style="font-family:'DM Mono';font-size:10px">${esc(item.reference_number)}</td><td><a class="text-link" href="${esc(item.proof_path)}" target="_blank" rel="noreferrer">View proof ↗</a></td><td>${statusPill(item.status)}</td><td>${item.admin_reason ? esc(item.admin_reason) : "—"}</td></tr>`).join("") || `<tr><td colspan="7"><div class="empty-state"><strong>No payment history</strong><p>Your submitted proofs will appear here.</p></div></td></tr>`}</tbody></table></div></div>`;
}

// Renders the profile and a form for editing details.
async function renderProfile() {
  const data = await api("/api/profile");
  state.profile = data.profile;
  const p = data.profile;
  $("#page-container").innerHTML =
    `<div class="page"><div class="page-heading"><div><p class="eyebrow">YOUR PICKLEBALLS IDENTITY</p><h1>My profile</h1><p>Keep your player details up to date.</p></div></div><div class="profile-layout"><div class="card profile-card"><div class="profile-big">${initials(p.full_name)}</div><h2>${esc(p.full_name)}</h2><p>${esc(p.email)}</p><div class="profile-facts"><div class="profile-fact"><span>Skill level</span><strong>${esc(p.skill_level || "Beginner")}</strong></div><div class="profile-fact"><span>City</span><strong>${esc(p.city || "Not set")}</strong></div><div class="profile-fact"><span>Phone</span><strong>${esc(p.phone || "Not set")}</strong></div></div></div><div class="card"><div class="card-title"><h3>Edit details</h3><span class="pill confirmed">Member</span></div><form id="profile-form" class="profile-form"><label class="field-label full-width">Full name<input required class="field-input" name="fullName" value="${esc(p.full_name)}"></label><label class="field-label">Phone number<input class="field-input" name="phone" value="${esc(p.phone || "")}" placeholder="09xx xxx xxxx"></label><label class="field-label">City<input class="field-input" name="city" value="${esc(p.city || "")}" placeholder="Manila"></label><label class="field-label">Skill level<select class="field-input" name="skillLevel">${["Beginner", "Intermediate", "Advanced", "Pro"].map((level) => `<option ${p.skill_level === level ? "selected" : ""}>${level}</option>`).join("")}</select></label><button class="button primary full-width" type="submit">Save changes ↗</button></form></div></div></div>`;
  $("#profile-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.target.querySelector("button[type=submit]");
    const values = Object.fromEntries(new FormData(event.target));
    setBusy(button, true, "Saving…");
    try {
      await api("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      state.user.fullName = values.fullName;
      toast("Profile updated successfully.");
      await renderProfile();
      updateUserChrome();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(button, false);
    }
  });
}

// Renders notifications and marks them as read.
async function renderNotifications() {
  const data = await api("/api/notifications");
  await api("/api/notifications/read", { method: "POST" });
  $("#notification-count").textContent = "0";
  $("#top-notification-badge").classList.add("hidden");
  $("#page-container").innerHTML =
    `<div class="page"><div class="page-heading"><div><p class="eyebrow">STAY IN THE LOOP</p><h1>Notifications</h1><p>Important updates from the PickleBalls team.</p></div></div><div class="card">${data.notifications.map((item) => `<div class="notification-item ${item.read_at ? "" : "unread"}"><div class="notification-icon">${item.type === "warning" ? "!" : item.type === "success" ? "✓" : "◌"}</div><div><h4>${esc(item.title)}</h4><p>${esc(item.message)}</p><time>${dateText(item.created_at, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</time></div></div>`).join("") || `<div class="empty-state"><strong>You’re all caught up</strong><p>New updates will appear here.</p></div>`}</div></div>`;
}

async function renderSettings() {
  $("#page-container").innerHTML =
    `<div class="page"><div class="page-heading"><div><p class="eyebrow">YOUR PREFERENCES</p><h1>Settings</h1><p>Simple controls for your PickleBalls experience.</p></div></div><div class="card settings-card"><div class="setting-row"><div><strong>Event reminders</strong><small>Get updates before your registered events.</small></div><div class="switch"></div></div><div class="setting-row"><div><strong>Payment updates</strong><small>Know as soon as an admin reviews your proof.</small></div><div class="switch"></div></div><div class="setting-row"><div><strong>Account security</strong><small>Your password is securely protected.</small></div><span class="pill confirmed">Protected</span></div><div class="setting-row"><div><strong>Need to update your details?</strong><small>Manage your player identity from your profile.</small></div><button class="button ghost small" data-page="profile">Open profile ↗</button></div><div class="setting-row danger-setting"><div><strong>Delete account</strong><small>This permanently removes your profile, bookings, schedules, and payment history.</small></div><button class="button danger small" id="delete-account-button">Delete account</button></div></div></div>`;
  $("#delete-account-button").addEventListener("click", async () => {
    if (!window.confirm("Delete your account permanently? This cannot be undone.")) return;
    const button = $("#delete-account-button");
    setBusy(button, true, "Deleting…");
    try {
      await api("/api/account", { method: "DELETE" });
      toast("Your account was deleted.");
      setTimeout(() => location.reload(), 500);
    } catch (error) {
      toast(error.message, "error");
      setBusy(button, false);
    }
  });
}

// Binubuksan ang admin console at mga tab
async function openAdmin() {
  const [
    stats,
    payments,
    events,
    users,
    registrations,
    notifications,
    schedules,
  ] = await Promise.all([
    api("/api/admin/stats"),
    api("/api/admin/payments"),
    api("/api/admin/events"),
    api("/api/admin/users"),
    api("/api/admin/registrations"),
    api("/api/admin/notifications"),
    api("/api/admin/schedules"),
  ]);
  state.adminData = {
    stats,
    payments: payments.payments,
    events: events.events,
    users: users.users,
    registrations: registrations.registrations,
    notifications: notifications.notifications,
    schedules: schedules.schedules,
  };
  const pendingAdmins = state.adminData.users.filter(
    (user) => user.admin_requested,
  ).length;
  if (pendingAdmins) state.adminTab = "users";
  $("#page-container").innerHTML =
    `<div class="page"><div class="admin-banner"><div><p class="eyebrow" style="color:var(--lime)">ADMIN CONSOLE</p><h2>Court operations, at a glance.</h2><p>Review bookings and payments, manage courts, members, and playing schedules.</p></div><div class="heading-actions"><button class="button ghost small" id="new-account-button">Create account ↗</button><button class="button lime small" id="new-event-button">Add court ↗</button></div></div><div class="admin-stat-grid"><div class="stat-card"><div class="stat-top"><span>Members</span><span class="stat-icon">◎</span></div><div class="stat-value">${stats.users}</div></div><div class="stat-card"><div class="stat-top"><span>Published courts</span><span class="stat-icon">✦</span></div><div class="stat-value">${stats.events}</div></div><div class="stat-card"><div class="stat-top"><span>Bookings</span><span class="stat-icon">▤</span></div><div class="stat-value">${stats.registrations}</div></div><div class="stat-card"><div class="stat-top"><span>Verified revenue</span><span class="stat-icon">₱</span></div><div class="stat-value">${money(stats.revenue)}</div></div></div><div class="admin-tabs">${[
      ["payments", "Payment proofs"],
      ["events", "Courts"],
      ["registrations", "Bookings"],
      ["users", `Members${pendingAdmins ? ` · ${pendingAdmins}` : ""}`],
      ["schedules", "Schedules"],
      ["notifications", "Notifications"],
    ]
      .map(
        ([key, label]) =>
          `<button class="admin-tab ${state.adminTab === key ? "active" : ""}" data-admin-tab="${key}">${label}</button>`,
      )
      .join("")}</div><div id="admin-table"></div></div>`;
  renderAdminTable();
  $("#new-event-button").addEventListener("click", () => showCourtModal());
  $("#new-account-button").addEventListener("click", () => showAccountModal());
}

// Gumagawa ng table para sa admin payments o courts
function adminUserActions(user) {
  if (user.id === state.user?.id) return "Current account";
  if (user.is_super_admin) return "Protected";
  if (user.role === "admin" && !isSuperAdmin()) return "Super admin only";
  return `<button class="button danger small delete-user" data-id="${user.id}">Delete account</button>`;
}

function adminRegistrationActions(registration) {
  if (registration.status === "pending") {
    return `<button class="button primary small registration-approval" data-id="${registration.id}" data-action="approve">Approve</button> <button class="button danger small registration-approval" data-id="${registration.id}" data-action="reject">Reject</button>`;
  }
  if (registration.status === "cancelled") return `<span class="pill cancelled">Cancelled</span>`;
  return `<button class="button danger small admin-cancel-booking" data-id="${registration.id}">Cancel booking</button>`;
}

function renderAdminTable() {
  const data = state.adminData;
  const target = $("#admin-table");
  let html = "";
  if (state.adminTab === "payments")
    html = `<div class="card table-card"><table class="data-table"><thead><tr><th>Player</th><th>Court</th><th>Amount</th><th>Reference</th><th>Proof</th><th>Status</th><th>Action</th></tr></thead><tbody>${data.payments.map((p) => `<tr><td><div class="person-cell"><span class="mini-avatar">${initials(p.full_name)}</span>${esc(p.full_name)}</div><small style="color:#9aa69f">${esc(p.email)}</small><br><small class="admin-phone">☎ ${esc(p.phone || "No phone")}</small></td><td>${esc(p.event_name)}</td><td>${money(p.amount)}</td><td style="font:10px 'DM Mono'">${esc(p.reference_number)}</td><td><a class="text-link" href="${esc(p.proof_path)}" target="_blank" rel="noreferrer">View proof ↗</a></td><td>${statusPill(p.status)}</td><td>${p.status === "pending" ? `<button class="button primary small review-payment" data-id="${p.id}" data-action="verified">Verify</button> <button class="button danger small review-payment" data-id="${p.id}" data-action="rejected">Reject</button>` : "Reviewed"}</td></tr>`).join("") || `<tr><td colspan="7"><div class="empty-state"><strong>No payment proofs</strong><p>Submitted proofs will appear here.</p></div></td></tr>`}</tbody></table></div>`;
  if (state.adminTab === "events")
    html = `<div class="card table-card"><div class="admin-table-intro"><div><p class="eyebrow">COURT INVENTORY</p><h3>Your published courts</h3><p>Keep availability, capacity, and court details up to date.</p></div><span class="pill confirmed">${data.events.length} listed</span></div><table class="data-table"><thead><tr><th>Court</th><th>Date</th><th>Type</th><th>Rating</th><th>Slots</th><th>Status</th><th>Action</th></tr></thead><tbody>${data.events.map((event, index) => `<tr><td><div class="admin-court-cell"><span class="admin-court-swatch court-media-${index % 3}"></span><div><strong>${esc(event.name)}</strong><br><small>${esc(event.location)}</small></div></div></td><td>${dateText(event.event_date)}</td><td>${esc(event.category)}</td><td>${Number(event.review_count || 0) ? `★ ${Number(event.rating || 0).toFixed(1)} <small>(${event.review_count})</small>` : "No ratings"}</td><td>${event.registered_count} / ${event.max_participants}</td><td>${statusPill(event.status)}</td><td><button class="button ghost small edit-event" data-id="${event.id}">Edit</button> <button class="button danger small delete-event" data-id="${event.id}">Delete</button></td></tr>`).join("") || `<tr><td colspan="7"><div class="empty-state"><strong>No courts yet</strong><p>Add your first court to start accepting bookings.</p></div></td></tr>`}</tbody></table></div>`;
  if (state.adminTab === "registrations")
     html = `<div class="card table-card"><div class="admin-table-intro"><div><p class="eyebrow">BOOKING REQUESTS</p><h3>Review member bookings</h3><p>Approve requests and keep payment status visible at a glance.</p></div><span class="pill pending">${data.registrations.filter((item) => item.status === "pending").length} pending</span></div><table class="data-table"><thead><tr><th>Player</th><th>Court</th><th>Registered</th><th>Booking</th><th>Payment</th><th>Action</th></tr></thead><tbody>${data.registrations.map((r) => `<tr><td><div class="person-cell"><span class="mini-avatar">${initials(r.full_name)}</span>${esc(r.full_name)}</div><small style="color:#9aa69f">${esc(r.email)}</small><br><small class="admin-phone">☎ ${esc(r.phone || "No phone")}</small></td><td>${esc(r.event_name)}</td><td>${dateText(r.registered_at)}</td><td>${confirmationPill(r.confirmation_status)}</td><td>${r.payment_status ? statusPill(r.payment_status) : "—"}</td><td>${adminRegistrationActions(r)}</td></tr>`).join("") || `<tr><td colspan="6"><div class="empty-state"><strong>No bookings yet</strong><p>Member court requests will appear here.</p></div></td></tr>`}</tbody></table></div>`;
  if (state.adminTab === "users")
     html = `<div class="card table-card">${data.users.some((u) => u.admin_requested) ? `<div class="notice admin-approval-notice"><strong>Administrator approval is needed.</strong> Review the pending request below.</div>` : ""}<table class="data-table"><thead><tr><th>Member</th><th>Contact</th><th>Access</th><th>Registrations</th><th>Joined</th><th>Action</th></tr></thead><tbody>${data.users.map((u) => `<tr><td><div class="person-cell"><span class="mini-avatar">${initials(u.full_name)}</span>${esc(u.full_name)}</div></td><td>${esc(u.email)}<br><small style="color:#9aa69f">${esc(u.phone || "No phone")}</small></td><td>${u.admin_requested ? `<span class="pill pending">Admin pending</span>` : u.is_super_admin ? `<span class="pill confirmed">Super admin</span>` : u.role === "admin" ? `<span class="pill confirmed">Admin</span>` : `<span class="pill draft">Member</span>`}</td><td>${u.registrations}</td><td>${dateText(u.created_at)}</td><td>${u.admin_requested ? (isSuperAdmin() ? `<button class="button primary small admin-approval" data-id="${u.id}" data-action="approve">Approve</button> <button class="button danger small admin-approval" data-id="${u.id}" data-action="reject">Reject</button>` : "Super admin review") : adminUserActions(u)}</td></tr>`).join("") || `<tr><td colspan="6"><div class="empty-state"><strong>No accounts yet</strong><p>Created members will appear here.</p></div></td></tr>`}</tbody></table></div>`;
  if (state.adminTab === "schedules")
     html = `<div class="card table-card"><div class="admin-table-intro"><div><p class="eyebrow">MEMBER PLAY TIMES</p><h3>All member schedules</h3><p>Manual schedules and court bookings appear here, one time slot per row.</p></div><span class="pill confirmed">${data.schedules.length} total</span></div><table class="data-table"><thead><tr><th>Player</th><th>Schedule</th><th>Date & time</th><th>Location</th><th>Notes</th></tr></thead><tbody>${data.schedules.map((item) => `<tr class="${item.completed ? "completed-row" : ""}"><td><strong>${esc(item.full_name)}</strong><br><small style="color:#9aa69f">${esc(item.email)}</small><br><small class="admin-phone">☎ ${esc(item.phone || "No phone")}</small></td><td>${esc(item.title)}<br><span class="schedule-source">${item.source === "booking" ? "Court booking" : "Saved schedule"}</span>${item.completed ? `<br><span class="pill completed">Completed</span>` : ""}</td><td>${dateText(item.schedule_date)}<br><small>${esc(scheduleTimeText(item.start_time, item.end_time))}</small></td><td>${esc(item.location)}</td><td>${confirmationPill(item.confirmation_status)} ${esc(item.notes || "—")}</td></tr>`).join("") || `<tr><td colspan="5"><div class="empty-state"><strong>No player schedules</strong><p>Members’ saved playing times and court bookings will appear here.</p></div></td></tr>`}</tbody></table></div>`;
  if (state.adminTab === "notifications")
    html = `<div class="card"><div class="card-title"><h3>Send an update</h3><button class="button lime small" id="broadcast-button">New notification ↗</button></div><div class="notice">Broadcast a message to all members, or send a private update to one player.</div><div class="notification-list">${data.notifications.map((item) => `<div class="notification-item"><div class="notification-icon">◌</div><div><h4>${esc(item.title)}</h4><p>${esc(item.message)}</p><time>${item.recipient_name ? `To ${esc(item.recipient_name)} · ` : "To all members · "}${dateText(item.created_at)}</time></div></div>`).join("") || `<div class="empty-state"><strong>No notifications sent yet</strong><p>Send your first club update.</p></div>`}</div></div>`;
  target.innerHTML = html;
  $("#broadcast-button")?.addEventListener("click", () =>
    showNotificationModal(),
  );
}

// Displays the support desk modal
function showSupportModal() {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.id = "support-modal";
  modal.innerHTML = `<div class="modal support-modal"><div class="modal-header"><div><p class="eyebrow">PICKLEBALLS SUPPORT</p><h2>How can we help?</h2></div><button class="modal-close" type="button" aria-label="Close support dialog">×</button></div><p class="support-intro">Need help with your account, events, payments, or schedule? Send us a message and our support desk will get back to you.</p><div class="support-actions"><a class="button primary full-width" href="mailto:sacredmod1@gmail.com?subject=PickleBalls%20support%20request">Email support <span>↗</span></a><button class="button ghost full-width modal-close" type="button">Close</button></div></div>`;
  $("#modal-root").append(modal);
  modal
    .querySelectorAll(".modal-close")
    .forEach((button) =>
      button.addEventListener("click", () => modal.remove()),
    );
}

function showBookingConfirmationModal(data, courtName = "your court", bookingDate = "") {
  const total = Number(data?.total || 0);
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.id = "booking-confirmation-modal";
  modal.innerHTML = `<div class="modal booking-confirmation-modal"><div class="modal-header"><div><p class="eyebrow">BOOKING REQUEST SENT</p><h2>Your time is reserved for review.</h2></div><button class="modal-close" type="button" aria-label="Close booking confirmation">×</button></div><div class="booking-confirmation-icon">✓</div><p class="support-intro">Your selected time at <strong>${esc(courtName)}</strong>${bookingDate ? ` for ${esc(dateText(`${bookingDate}T12:00:00`))}` : ""} has been sent to the admin.</p><div class="booking-confirmation-total"><span>Booking total</span><strong>${money(total)}</strong></div><div class="notice"><strong>Payment is needed after admin approval.</strong><br>You can open the Payments page now. It will show the payment form as soon as your booking is approved.</div><div class="support-actions"><button class="button primary full-width" id="booking-payment-button" type="button">Open payment page ↗</button><button class="button ghost full-width modal-close" type="button">Stay on court details</button></div></div>`;
  $("#modal-root").append(modal);
  modal.querySelectorAll(".modal-close").forEach((button) => {
    button.addEventListener("click", () => modal.remove());
  });
  $("#booking-payment-button").addEventListener("click", async () => {
    modal.remove();
    await openPaymentPage(data?.registrationId);
  });
}

// nagapakita ug account sa modal
function showAccountModal() {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.id = "account-modal";
  modal.innerHTML = `<div class="modal"><div class="modal-header"><div><p class="eyebrow">ACCOUNT MANAGEMENT</p><h2>Create an account</h2></div><button class="modal-close">×</button></div><form id="account-form" class="modal-form"><label class="full-width">Full name<input required name="fullName" placeholder="Richard Ryan Sison"></label><label class="full-width">Email address<input required type="email" name="email" placeholder="richard094@gmail.com"></label><label>Password<span class="password-control"><input required minlength="8" type="password" name="password" placeholder="8+ characters"><button class="password-toggle" type="button" data-password-toggle aria-label="Show password">Show</button></span></label><label>Account type<select name="accountType"><option value="member">Member</option>${isSuperAdmin() ? `<option value="admin">Administrator</option>` : ""}</select></label><div class="modal-actions"><button type="button" class="button ghost modal-close">Cancel</button><button class="button primary" type="submit">Create account ↗</button></div></form></div>`;
  $("#modal-root").append(modal);
  modal
    .querySelectorAll(".modal-close")
    .forEach((button) =>
      button.addEventListener("click", () => modal.remove()),
    );
  $("#account-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.target.querySelector("button[type=submit]");
    setBusy(button, true, "Creating…");
    try {
      await api("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(event.target))),
      });
      modal.remove();
      toast("Account created.");
      await openAdmin();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(button, false);
    }
  });
}

// Displays a form for adding or editing a court.
function showCourtModal(event = null) {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.id = "court-modal";
  const rules = courtRules(event || {});
  const rulePrice = (index) => rules[index]?.price ?? event?.fee ?? 265;
  const amenities = courtAmenities(event).join(", ");
  modal.innerHTML = `<div class="modal court-modal"><div class="modal-header"><div><p class="eyebrow">${event ? "UPDATE COURT" : "NEW COURT LISTING"}</p><h2>${event ? "Edit court" : "Add a court"}</h2><p class="modal-subtitle">Set the details members will see before they choose a slot.</p></div><button class="modal-close">×</button></div><form id="court-form" class="modal-form" enctype="multipart/form-data">
    <label class="full-width">Court name<input required name="name" value="${esc(event?.name || "")}" placeholder="CCMI Pickleball Court"></label>
    <label class="full-width">Court image<input type="file" name="image" accept="image/jpeg,image/png,image/webp"><small class="field-hint">JPG, PNG or WEBP · max 5MB</small></label>
    <label class="full-width">Or use an image URL<input name="imageUrl" type="url" value="${esc(event?.image_url || "")}" placeholder="https://example.com/court.jpg"></label>
    <label>Court type<select name="category">${["Indoor", "Outdoor", "Sport Court", "Community"].map((c) => `<option ${event?.category === c ? "selected" : ""}>${c}</option>`).join("")}</select></label>
    <label>Surface<input required name="surface" value="${esc(event?.surface || "Sport Court")}" placeholder="Sport Court"></label>
    <label>Location<input required name="location" value="${esc(event?.location || "")}" placeholder="Mati, Davao Oriental"></label>
    <label>Contact number<input required name="contact" value="${esc(event?.contact || "")}" placeholder="09XXXXXXXXX"></label>
    <label>Opening time<input required type="time" name="openingTime" value="${esc(event?.opening_time?.slice(0, 5) || "07:00")}"></label>
    <label>Closing time<input required type="time" name="closingTime" value="${esc(closingInputValue(event?.closing_time))}" max="21:00"><small class="field-hint">Bookings end at 9:00 PM.</small></label>
    <label class="full-width">Amenities<input name="amenities" value="${esc(amenities)}" placeholder="Lights, Restrooms, Parking, Pickleball Court, Food & Coffee"></label>
    <label>Maximum players<input required type="number" min="1" name="maxParticipants" value="${event?.max_participants || 20}"></label>
     <label>Default booking fee<input required type="number" min="1" step="0.01" name="fee" value="${event?.fee || rulePrice(0)}"></label>
    <label>Status<select name="status">${["draft", "published", "closed", "cancelled"].map((s) => `<option ${event?.status === s || (!event && s === "published") ? "selected" : ""}>${s}</option>`).join("")}</select></label>
    <label class="full-width">Court details<textarea required name="description" placeholder="Tell players what to expect.">${esc(event?.description || "")}</textarea></label>
    <div class="modal-actions"><button type="button" class="button ghost modal-close">Cancel</button><button class="button primary" type="submit">${event ? "Save court" : "Add court"} ↗</button></div>
  </form></div>`;
  $("#modal-root").append(modal);
  modal
    .querySelectorAll(".modal-close")
    .forEach((button) =>
      button.addEventListener("click", () => modal.remove()),
    );
  $("#court-form").addEventListener("submit", async (submitEvent) => {
    submitEvent.preventDefault();
    const form = submitEvent.target;
    const imageFile = form.elements.image.files?.[0];
    const imageUrl = form.elements.imageUrl.value.trim();
    if (!event && !imageFile && !imageUrl) {
      toast("Add a court image or a valid image URL before saving.", "error");
      return;
    }
    if (
      imageUrl &&
      !/^https?:\/\//i.test(imageUrl) &&
      !imageUrl.startsWith("/court-images/")
    ) {
      toast("Use a valid http(s) image URL.", "error");
      return;
    }
    const button = submitEvent.target.querySelector("button[type=submit]");
    setBusy(button, true, "Saving…");
    try {
      await api(event ? `/api/admin/events/${event.id}` : "/api/admin/events", {
        method: event ? "PUT" : "POST",
        body: new FormData(submitEvent.target),
      });
      modal.remove();
      toast(event ? "Court updated." : "Court added.");
      await openAdmin();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(button, false);
    }
  });
}

// display a form for the events.
function showEventModal(event = null) {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.id = "event-modal";
  modal.innerHTML = `<div class="modal"><div class="modal-header"><div><p class="eyebrow">${event ? "UPDATE CALENDAR" : "NEW CALENDAR ENTRY"}</p><h2>${event ? "Edit event" : "Create an event"}</h2></div><button class="modal-close">×</button></div><form id="event-form" class="modal-form"><label class="full-width">Event name<input required name="name" value="${esc(event?.name || "")}" placeholder="Sunset Social Doubles"></label><label>Date & time<input required type="datetime-local" name="eventDate" value="${event ? new Date(event.event_date).toISOString().slice(0, 16) : ""}"></label><label>Category<select name="category">${["Social", "Tournament", "Clinic", "Community"].map((c) => `<option ${event?.category === c ? "selected" : ""}>${c}</option>`).join("")}</select></label><label>Location<input required name="location" value="${esc(event?.location || "")}" placeholder="BGC Pickleball Club"></label><label>Registration fee<input required type="number" min="0" step="0.01" name="fee" value="${event?.fee || 0}"></label><label>Maximum participants<input required type="number" min="1" name="maxParticipants" value="${event?.max_participants || 20}"></label><label>Status<select name="status">${["draft", "published", "closed", "cancelled"].map((s) => `<option ${event?.status === s || (!event && s === "published") ? "selected" : ""}>${s}</option>`).join("")}</select></label><label class="full-width">Description<textarea required name="description" placeholder="Tell players what to expect.">${esc(event?.description || "")}</textarea></label><div class="modal-actions"><button type="button" class="button ghost modal-close">Cancel</button><button class="button primary" type="submit">${event ? "Save changes" : "Create event"} ↗</button></div></form></div>`;
  $("#modal-root").append(modal);
  modal
    .querySelectorAll(".modal-close")
    .forEach((button) =>
      button.addEventListener("click", () => modal.remove()),
    );
  $("#event-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = e.target.querySelector("button[type=submit]");
    setBusy(button, true, "Saving…");
    try {
      const payload = Object.fromEntries(new FormData(e.target));
      await api(event ? `/api/admin/events/${event.id}` : "/api/admin/events", {
        method: event ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      modal.remove();
      toast(event ? "Event updated." : "Event created.");
      await openAdmin();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(button, false);
    }
  });
}

// Displays a form for sending a notification.
function showNotificationModal() {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.id = "notification-modal";
  modal.innerHTML = `<div class="modal"><div class="modal-header"><div><p class="eyebrow">KEEP THE CLUB MOVING</p><h2>Send a notification</h2></div><button class="modal-close modal-close-button">×</button></div><form id="notification-form" class="modal-form"><label class="full-width">Title<input required name="title" placeholder="New court availability"></label><label class="full-width">Message<textarea required name="message" placeholder="Share an update with the RallyPoint community."></textarea></label><label class="full-width">Recipient<select name="userId"><option value="">All members</option>${state.adminData.users
    .filter((user) => user.role !== "admin")
    .map(
      (user) =>
        `<option value="${user.id}">${esc(user.full_name)} — ${esc(user.email)}</option>`,
    )
    .join(
      "",
    )}</select></label><div class="modal-actions"><button type="button" class="button ghost modal-close-button">Cancel</button><button class="button primary" type="submit">Send update ↗</button></div></form></div>`;
  $("#modal-root").append(modal);
  modal
    .querySelectorAll(".modal-close-button")
    .forEach((button) =>
      button.addEventListener("click", () => modal.remove()),
    );
  $("#notification-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.target.querySelector("button[type=submit]");
    setBusy(button, true, "Sending…");
    try {
      await api("/api/admin/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(event.target))),
      });
      modal.remove();
      toast("Notification sent.");
      await openAdmin();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(button, false);
    }
  });
}

document.addEventListener("click", async (event) => {
  const nav = event.target.closest("[data-page]");
  if (nav) {
    event.preventDefault();
    await navigate(nav.dataset.page);
    return;
  }
  const viewCourt = event.target.closest(".view-court");
  if (viewCourt) {
    await showCourtDetails(Number(viewCourt.dataset.id));
    return;
  }
  const slotStep = event.target.closest("[data-slot-date-step]");
  if (slotStep && state.selectedCourt) {
    const nextDate = new Date(`${state.selectedSlotDate}T12:00:00`);
    nextDate.setDate(
      nextDate.getDate() + Number(slotStep.dataset.slotDateStep),
    );
    await showCourtDetails(state.selectedCourt.id, localDate(nextDate));
    return;
  }
  const slotCell = event.target.closest(".slot-cell");
  if (slotCell && !slotCell.disabled) {
    const slotId = Number(slotCell.dataset.slotId);
    state.selectedSlotIds = state.selectedSlotIds.includes(slotId)
      ? state.selectedSlotIds.filter((id) => id !== slotId)
      : [...state.selectedSlotIds, slotId];
    slotCell.classList.toggle(
      "selected",
      state.selectedSlotIds.includes(slotId),
    );
     const stateLabel = slotCell.querySelector(".slot-state");
    if (stateLabel)
      stateLabel.textContent = state.selectedSlotIds.includes(slotId)
        ? "OPEN"
        : "OPEN";
    updateBookingSummary();
    return;
  }
  const confirmBooking = event.target.closest("#confirm-slot-booking");
  if (confirmBooking && state.selectedCourt && state.selectedSlotIds.length) {
    setBusy(confirmBooking, true, "Requesting…");
    try {
      const data = await api("/api/slots/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courtId: state.selectedCourt.id,
          slotIds: state.selectedSlotIds,
        }),
      });
       toast("Your selected slots were sent for admin approval.");
       showBookingConfirmationModal(
         data,
         state.selectedCourt.name,
         state.selectedSlotDate,
       );
      await showCourtDetails(state.selectedCourt.id, state.selectedSlotDate);
    } catch (error) {
      toast(error.message, "error");
      await showCourtDetails(state.selectedCourt.id, state.selectedSlotDate);
    } finally {
      setBusy(confirmBooking, false);
    }
    return;
  }
  const register = event.target.closest(".register-event");
  if (register) {
    const button = register;
    setBusy(button, true, "Booking…");
    try {
      const data = await api(`/api/events/${button.dataset.id}/register`, {
        method: "POST",
      });
       toast("Your court booking request was submitted.");
       showBookingConfirmationModal(
         data,
         state.events.find((item) => item.id === Number(button.dataset.id))?.name,
       );
      await (state.page === "dashboard" ? renderDashboard() : renderEvents());
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(button, false);
    }
    return;
  }
  const pay = event.target.closest(".pay-for-event");
  if (pay) {
    await openPaymentPage(Number(pay.dataset.id));
    return;
  }
  const cancelBooking = event.target.closest(".cancel-booking");
  if (cancelBooking) {
    if (!window.confirm("Cancel this booking and release its time slots?")) return;
    setBusy(cancelBooking, true, "Cancelling…");
    try {
      await api(`/api/registrations/${cancelBooking.dataset.id}/cancel`, {
        method: "PATCH",
      });
      toast("Booking cancelled. The selected time slots are open again.");
      await renderRegistrations();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(cancelBooking, false);
    }
    return;
  }
  const adminTab = event.target.closest("[data-admin-tab]");
  if (adminTab) {
    state.adminTab = adminTab.dataset.adminTab;
    $$(".admin-tab").forEach((tab) =>
      tab.classList.toggle("active", tab === adminTab),
    );
    renderAdminTable();
    return;
  }
  const review = event.target.closest(".review-payment");
  if (review) {
    let reason = "";
    if (review.dataset.action === "rejected") {
      reason = window.prompt("Reason for rejecting this proof:") || "";
      if (!reason) return;
    }
    try {
      await api(`/api/admin/payments/${review.dataset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: review.dataset.action, reason }),
      });
      toast(
        review.dataset.action === "verified"
          ? "Payment verified and registration confirmed."
          : "Payment rejected with reason.",
      );
      await openAdmin();
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }
  const registrationApproval = event.target.closest(".registration-approval");
  if (registrationApproval) {
    try {
      await api(`/api/admin/registrations/${registrationApproval.dataset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: registrationApproval.dataset.action }),
      });
      toast(
        registrationApproval.dataset.action === "approve"
          ? "Registration approved."
          : "Registration rejected.",
      );
      await openAdmin();
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }
  const adminCancelBooking = event.target.closest(".admin-cancel-booking");
  if (adminCancelBooking) {
    if (!window.confirm("Cancel this booking and release its time slots?")) return;
    setBusy(adminCancelBooking, true, "Cancelling…");
    try {
      await api(`/api/admin/registrations/${adminCancelBooking.dataset.id}`, {
        method: "DELETE",
      });
      toast("Booking cancelled and its time slots are open again.");
      await openAdmin();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(adminCancelBooking, false);
    }
    return;
  }
  const deleteUser = event.target.closest(".delete-user");
  if (deleteUser) {
    if (!window.confirm("Delete this account and all of its bookings permanently?")) return;
    setBusy(deleteUser, true, "Deleting…");
    try {
      await api(`/api/admin/users/${deleteUser.dataset.id}`, {
        method: "DELETE",
      });
      toast("Account deleted.");
      await openAdmin();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(deleteUser, false);
    }
    return;
  }
  const approval = event.target.closest(".admin-approval");
  if (approval) {
    try {
      await api(`/api/admin/users/${approval.dataset.id}/admin-approval`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: approval.dataset.action }),
      });
      toast(
        approval.dataset.action === "approve"
          ? "Admin account approved."
          : "Admin request rejected.",
      );
      await openAdmin();
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }
  const editSchedule = event.target.closest(".edit-schedule");
  if (editSchedule) {
    const item = state.schedules.find(
      (schedule) => schedule.id === Number(editSchedule.dataset.id),
    );
    if (item) {
      const form = $("#schedule-form");
      form.elements.id.value = item.id;
      form.elements.title.value = item.title;
      form.elements.scheduleDate.value = item.schedule_date.slice(0, 10);
      form.elements.startTime.value = item.start_time.slice(0, 5);
      form.elements.endTime.value = item.end_time
        ? item.end_time.slice(0, 5)
        : "";
      form.elements.location.value = item.location;
      form.elements.notes.value = item.notes || "";
      $("#cancel-schedule-edit").classList.remove("hidden");
      form.querySelector("button[type=submit]").textContent =
        "Update schedule ↗";
      form.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    return;
  }
  const deleteSchedule = event.target.closest(".delete-schedule");
  if (deleteSchedule && window.confirm("Delete this playing schedule?")) {
    try {
      await api(`/api/schedules/${deleteSchedule.dataset.id}`, {
        method: "DELETE",
      });
      toast("Schedule deleted.");
      await renderSchedule();
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }
  const edit = event.target.closest(".edit-event");
  if (edit) {
    showCourtModal(
      state.adminData.events.find(
        (item) => item.id === Number(edit.dataset.id),
      ),
    );
    return;
  }
  const remove = event.target.closest(".delete-event");
  if (remove && window.confirm("Delete this event and its registrations?")) {
    try {
      await api(`/api/admin/events/${remove.dataset.id}`, { method: "DELETE" });
      toast("Event deleted.");
      await openAdmin();
    } catch (error) {
      toast(error.message, "error");
    }
  }
});

document.addEventListener("change", async (event) => {
  if (
    event.target.id !== "slot-date" ||
    !state.selectedCourt ||
    !event.target.value
  )
    return;
  await showCourtDetails(state.selectedCourt.id, event.target.value);
});

$("#login-form").addEventListener("submit", (event) =>
  auth(event, "login"),
);
$("#admin-login-form").addEventListener("submit", (event) =>
  auth(event, "admin"),
);
$("#register-form").addEventListener("submit", (event) =>
  auth(event, "register"),
);
$("#admin-register-form").addEventListener("submit", (event) =>
  auth(event, "admin-register"),
);
$("#forgot-form").addEventListener("submit", forgotPassword);
$("#reset-form").addEventListener("submit", resetPassword);
document.addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-password-toggle]");
  if (!toggle) return;
  const input = toggle.closest(".password-control")?.querySelector("input");
  if (!input) return;
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  toggle.textContent = showing ? "Show" : "Hide";
  toggle.setAttribute(
    "aria-label",
    showing ? "Show password" : "Hide password",
  );
});
$$(".auth-tab").forEach((tab) =>
  tab.addEventListener("click", () => switchAuth(tab.dataset.authTab)),
);
$("[data-auth-tab='forgot']").addEventListener("click", () =>
  switchAuth("forgot"),
);
$$(".back-to-login").forEach((button) =>
  button.addEventListener("click", () => switchAuth("login")),
);
$("#auth-menu-toggle").addEventListener("click", () => {
  $("#auth-side-menu").classList.add("open");
  $("#auth-menu-backdrop").classList.add("open");
  $("#auth-menu-toggle").setAttribute("aria-expanded", "true");
});
const closeAuthMenu = () => {
  $("#auth-side-menu").classList.remove("open");
  $("#auth-menu-backdrop").classList.remove("open");
  $("#auth-menu-toggle").setAttribute("aria-expanded", "false");
};
$("#auth-menu-close").addEventListener("click", closeAuthMenu);
$("#auth-menu-backdrop").addEventListener("click", closeAuthMenu);
$$(".auth-menu-item").forEach((item) =>
  item.addEventListener("click", () => {
    switchAuth(item.dataset.authTab);
    closeAuthMenu();
  }),
);
$("#support-desk-button").addEventListener("click", showSupportModal);
$("#logout-button").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  location.reload();
});
$("#menu-toggle").addEventListener("click", () =>
  $(".sidebar").classList.add("open"),
);
$("#close-sidebar").addEventListener("click", () =>
  $(".sidebar").classList.remove("open"),
);
$("#open-profile").addEventListener("click", () => navigate("profile"));

(async function start() {
  const resetToken = new URLSearchParams(location.search).get("token");
  if (resetToken) {
    $("#reset-token").value = resetToken;
    switchAuth("reset");
    return;
  }
  try {
    const data = await api("/api/auth/me");
    if (data.user) {
      state.user = data.user;
      await bootApp();
    }
  } catch (error) {
    console.error(error);
  }
})();
