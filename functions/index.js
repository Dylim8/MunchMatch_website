const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({ maxInstances: 10 });

const PLACES_KEY = defineSecret("GOOGLE_PLACES_KEY");

const PRICE_LEVELS = [
  "PRICE_LEVEL_INEXPENSIVE",
  "PRICE_LEVEL_MODERATE",
  "PRICE_LEVEL_EXPENSIVE",
  "PRICE_LEVEL_VERY_EXPENSIVE",
];

const PRICE_LABEL = {
  PRICE_LEVEL_FREE:           "Free",
  PRICE_LEVEL_INEXPENSIVE:    "$",
  PRICE_LEVEL_MODERATE:       "$$",
  PRICE_LEVEL_EXPENSIVE:      "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.photos",
  "places.formattedAddress",
  "places.googleMapsUri",
  "places.primaryTypeDisplayName",
  "nextPageToken",
].join(",");

// Matches the option values in public/index.html's Create Group form —
// anything outside these allowlists gets coerced to a safe default rather
// than passed through to the Places API or stored as-is.
const MEALTIME_OPTIONS = ["breakfast", "lunch", "dinner"];
const CUISINE_OPTIONS = [
  "", "american_restaurant", "barbecue_restaurant", "chinese_restaurant",
  "french_restaurant", "greek_restaurant", "indian_restaurant", "italian_restaurant",
  "japanese_restaurant", "korean_restaurant", "mediterranean_restaurant", "mexican_restaurant",
  "middle_eastern_restaurant", "pizza_restaurant", "seafood_restaurant", "sushi_restaurant",
  "thai_restaurant", "vietnamese_restaurant", "vegetarian_restaurant", "fast_food_restaurant", "cafe",
];
const RATING_OPTIONS = ["", "3.0", "3.5", "4.0", "4.5"];

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

function genCode(n = 6) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

// Fetch one page of results, return { places, nextPageToken }
async function fetchPage(key, body) {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type":     "application/json",
      "X-Goog-Api-Key":   key,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new HttpsError("internal", err?.error?.message || `Places API error ${res.status}`);
  }

  const data = await res.json();
  return { places: data.places || [], nextPageToken: data.nextPageToken || null };
}

// Fetch up to maxPages pages, stopping early if we hit targetCount results
async function fetchAllPages(key, baseBody, targetCount = 20, maxPages = 3) {
  const allPlaces = [];
  let pageToken   = null;

  for (let page = 0; page < maxPages; page++) {
    const body = { ...baseBody, pageSize: 20 };
    if (pageToken) body.pageToken = pageToken;

    const { places, nextPageToken } = await fetchPage(key, body);
    allPlaces.push(...places);
    pageToken = nextPageToken;

    // Stop if we have enough or no more pages
    if (allPlaces.length >= targetCount || !nextPageToken) break;

    // Small delay between paginated requests to avoid rate limits
    if (page < maxPages - 1) await new Promise(r => setTimeout(r, 150));
  }

  // Deduplicate by place ID in case of overlap
  const seen = new Set();
  return allPlaces.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id); return true;
  });
}

// Private helper — not exported. Only createGroup calls this; there is no
// longer a standalone callable endpoint for fetching restaurants on their
// own, since that has no independent product use and would just be
// duplicated attack surface (auth + rate-limit logic, another billable
// endpoint) for zero benefit.
async function fetchRestaurantResults(filters, key) {
  const { location, lat, lng, distance, mealtime, price, cuisine, rating, dietary, openNow } = filters;

  const radiusMeters = Math.min((parseInt(distance) || 5) * 1609, 50000);
  const priceLevels  = PRICE_LEVELS.slice(0, parseInt(price) || 2);

  const dietaryPrefix = dietary === "vegan" ? "vegan " : "";
  const hasCoords = lat != null && lng != null;
  // With real coordinates, the query text stays location-free and the bias
  // circle carries the precise position; otherwise fall back to letting
  // Places geocode the typed location text itself, same as before.
  const textQuery = hasCoords
    ? `${dietaryPrefix}${mealtime} restaurants`
    : `${dietaryPrefix}${mealtime} restaurants in ${location}`;

  const baseBody = {
    textQuery,
    priceLevels,
    locationBias: hasCoords
      ? { circle: { center: { latitude: lat, longitude: lng }, radius: radiusMeters } }
      : { circle: { radius: radiusMeters } },
  };

  if (openNow === true) baseBody.openNow = true;
  if (cuisine)          baseBody.includedType = cuisine;
  if (rating)           baseBody.minRating = parseFloat(rating);

  // Threshold below which the swipe deck feels too short to be fun
  const MIN_RESULTS = 10;

  // ── 1. Fetch up to 3 pages (60 results max) ───────────────────────────────
  let places = await fetchAllPages(key, baseBody, 20, 3);
  let lastBody = baseBody;

  // ── 2. Fallback: if still thin, retry with minRating relaxed ─────────────
  if (places.length < MIN_RESULTS && rating && parseFloat(rating) > 3.0) {
    console.log(`Only ${places.length} results with minRating ${rating}, retrying without rating filter`);
    const relaxedBody = { ...baseBody };
    delete relaxedBody.minRating;
    const fallbackPlaces = await fetchAllPages(key, relaxedBody, 20, 2);

    // Merge — keep originals, fill up with fallback results not already in the set
    const existingIds = new Set(places.map(p => p.id));
    const extras      = fallbackPlaces.filter(p => !existingIds.has(p.id));
    places            = [...places, ...extras].slice(0, 20);
    lastBody          = relaxedBody;
  }

  // ── 3. Fallback: if STILL thin, widen the search radius ──────────────────
  // A usable deck a bit further out beats an empty/tiny one at the exact
  // requested distance. Capped at the Places API's own 50km bias limit.
  if (places.length < MIN_RESULTS && radiusMeters < 50000) {
    const widerRadius = Math.min(radiusMeters * 2, 50000);
    console.log(`Only ${places.length} results within ${radiusMeters}m, widening to ${widerRadius}m`);
    const widerBody = { ...lastBody, locationBias: { circle: { radius: widerRadius } } };
    const widerPlaces = await fetchAllPages(key, widerBody, 20, 2);

    const existingIds = new Set(places.map(p => p.id));
    const extras      = widerPlaces.filter(p => !existingIds.has(p.id));
    places            = [...places, ...extras].slice(0, 20);
  }

  if (!places.length) {
    throw new HttpsError("not-found", "No restaurants found for that location.");
  }

  // ── 4. Resolve photo URIs server-side in parallel ─────────────────────────
  return Promise.all(
    places.map(async (p) => {
      let photoUri = null;

      if (p.photos?.[0]?.name) {
        try {
          const photoRes = await fetch(
            `https://places.googleapis.com/v1/${p.photos[0].name}/media` +
            `?maxWidthPx=600&skipHttpRedirect=true&key=${key}`
          );
          if (photoRes.ok) {
            const photoData = await photoRes.json();
            photoUri = photoData.photoUri || null;
          }
        } catch {
          // Non-fatal — card renders without a photo
        }
      }

      return {
        id:          p.id,
        name:        p.displayName?.text              || "Unknown",
        rating:      p.rating                         || null,
        reviewCount: p.userRatingCount                || 0,
        price:       PRICE_LABEL[p.priceLevel]        || null,
        cuisine:     p.primaryTypeDisplayName?.text   || null,
        photoUri,
        address:     p.formattedAddress               || "",
        mapsUrl:     p.googleMapsUri                  || `https://www.google.com/maps/place/?q=place_id:${p.id}`,
      };
    })
  );
}

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

// Per-UID, per-action fixed-window throttle. Anonymous accounts can be
// recreated at will, so this raises the bar against casual/scripted abuse
// but is not a substitute for App Check (that's the next layer, planned
// before public launch). Separate actions get separate windows (stored at
// rateLimits/{action}/{uid}, which is rules-locked to admin-only, so clients
// cannot forge or reset their own window) so heavy legitimate use of one
// callable never eats into another's quota.
async function checkRateLimit(db, uid, action, max) {
  const rateRef = db.ref(`rateLimits/${action}/${uid}`);
  const { committed } = await rateRef.transaction((current) => {
    const now = Date.now();
    if (!current || now - current.windowStart > RATE_LIMIT_WINDOW_MS) {
      return { windowStart: now, count: 1 };
    }
    if (current.count >= max) return; // abort, over quota
    return { windowStart: current.windowStart, count: current.count + 1 };
  });
  if (!committed) {
    throw new HttpsError("resource-exhausted", "Too many requests. Please wait a few minutes and try again.");
  }
}

// Transactionally reserves a unique group code with a temporary
// state:'loading' marker. Using a transaction (rather than get-then-set)
// correctly serializes two concurrent createGroup calls that happen to
// generate the same code.
async function reserveGroupCode(db, uid) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = genCode();
    const { committed } = await db.ref(`groups/${candidate}`).transaction((current) => {
      if (current !== null) return; // abort — taken
      return { state: "loading", ownerUid: uid, createdAt: Date.now() };
    });
    if (committed) return candidate;
  }
  throw new HttpsError("resource-exhausted", "Could not generate a unique group code. Please try again.");
}

// Creates a group end-to-end under the Admin SDK: validates and normalizes
// every filter server-side, reserves a unique code, fetches restaurants
// (deliberately outside any transaction — Realtime Database may rerun a
// transaction's update function on contention, and rerunning a billed
// external API call would be wrong), then commits the group atomically in
// one multi-path update. Clients can no longer write filters/createdAt/
// restaurants or the public counter directly (see database.rules.json).
exports.createGroup = onCall({ secrets: [PLACES_KEY] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign-in required.");
  }
  const uid = request.auth.uid;
  const db  = admin.database();

  const location = String(request.data?.location || "").trim().slice(0, 200);
  if (!location) {
    throw new HttpsError("invalid-argument", "Location is required.");
  }
  // Optional geolocation shortcut: only used transiently to bias the Places
  // search below, never persisted (see the update() call further down).
  // groups/{code}/filters is world-readable to anyone with the join code,
  // so the host's precise GPS position must never end up there.
  let lat = null, lng = null;
  const rawLat = parseFloat(request.data?.lat);
  const rawLng = parseFloat(request.data?.lng);
  if (Number.isFinite(rawLat) && Number.isFinite(rawLng) &&
      rawLat >= -90 && rawLat <= 90 && rawLng >= -180 && rawLng <= 180) {
    lat = rawLat;
    lng = rawLng;
  }
  const mealtime  = MEALTIME_OPTIONS.includes(request.data?.mealtime) ? request.data.mealtime : "dinner";
  const distance  = clamp(parseInt(request.data?.distance) || 5, 1, 25);
  const groupSize = clamp(parseInt(request.data?.groupSize) || 2, 2, 20);
  const price     = clamp(parseInt(request.data?.price) || 2, 1, 4);
  const cuisine   = CUISINE_OPTIONS.includes(request.data?.cuisine) ? request.data.cuisine : "";
  const rating    = RATING_OPTIONS.includes(String(request.data?.rating ?? "")) ? String(request.data.rating ?? "") : "";
  const dietary   = request.data?.dietary === "vegan" ? "vegan" : "";
  const openNow   = request.data?.openNow === true;
  const allowSwipeAgain = request.data?.allowSwipeAgain === true;

  await checkRateLimit(db, uid, "createGroup", 5);
  const groupCode = await reserveGroupCode(db, uid);

  let restaurants;
  try {
    restaurants = await fetchRestaurantResults(
      { location, lat, lng, distance, mealtime, price, cuisine, rating, dietary, openNow },
      PLACES_KEY.value()
    );
  } catch (e) {
    await db.ref(`groups/${groupCode}`).remove(); // free the code for reuse
    throw e instanceof HttpsError ? e : new HttpsError("internal", "Failed to fetch restaurants.");
  }

  await db.ref().update({
    [`groups/${groupCode}/filters`]:        { location, distance, groupSize, mealtime, price, cuisine, rating, dietary, openNow, allowSwipeAgain },
    [`groups/${groupCode}/restaurants`]:    restaurants,
    [`groups/${groupCode}/members/${uid}`]: { joinedAt: Date.now(), status: "waiting" },
    [`groups/${groupCode}/state`]:          "ready",
  });

  try {
    await db.ref("meta/partiesHelped").transaction((n) => (n || 0) + 1);
  } catch (e) {
    console.warn("Counter increment failed:", e);
  }

  return { groupCode, restaurants };
});

// Registers the caller as a member of a group, atomically enforcing groupSize.
// Runs under the Admin SDK (bypasses database rules) so it's the only path
// that can ever create a members/$uid record — clients may only update their
// own existing record afterward (e.g. flipping status to 'swiping').
exports.joinGroup = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign-in required.");
  }
  const uid       = request.auth.uid;
  const groupCode = String(request.data?.groupCode || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(groupCode)) {
    throw new HttpsError("invalid-argument", "Invalid group code.");
  }

  const db = admin.database();
  // Without this, a scripted caller could hammer this callable indefinitely
  // to rack up billed invocations or repeatedly attempt to join/fill groups.
  // (Note: reading whether a given code exists happens client-side via a
  // direct groups/$code read, which this rate limit does not cover. That
  // path has no per-request throttle available at the rules level, which is
  // exactly the kind of gap App Check is meant to close before public launch.)
  // Generous limit here since legitimate users may retry a mistyped code or
  // join more than one group per session.
  await checkRateLimit(db, uid, "joinGroup", 20);
  const groupRef = db.ref(`groups/${groupCode}`);

  const sizeSnap  = await groupRef.child("filters/groupSize").get();
  if (!sizeSnap.exists()) {
    throw new HttpsError("not-found", "Group not found.");
  }
  const groupSize = Number(sizeSnap.val());
  if (!Number.isInteger(groupSize) || groupSize < 2 || groupSize > 20) {
    throw new HttpsError("failed-precondition", "Group configuration is invalid.");
  }

  const { committed } = await groupRef.child("members").transaction((current) => {
    if (current && current[uid]) return current; // already a member — no-op
    const count = current ? Object.keys(current).length : 0;
    if (count >= groupSize) return; // abort — group is full
    return { ...(current || {}), [uid]: { joinedAt: Date.now(), status: "waiting" } };
  });

  if (!committed) {
    throw new HttpsError("resource-exhausted", "This group is already full.");
  }

  return { ok: true };
});

const GROUP_TTL_MS = 24 * 60 * 60 * 1000; // completed groups: 24h from creation
const STUCK_TTL_MS = 10 * 60 * 1000;      // abandoned state:'loading' reservations: 10min

// Runs hourly. Deletes any group older than GROUP_TTL_MS, plus any
// state:'loading' reservation older than STUCK_TTL_MS. A createGroup call
// that reserved a code but never finished (e.g. the function instance died
// mid-execution before its own cleanup ran; a normal call completes in well
// under a minute, so 10 minutes stuck in "loading" is unambiguously
// abandoned, not slow). No individual group data (filters, restaurants,
// members, swipes) is kept beyond this window.
//
// meta/partiesHelped is a separate, permanent counter incremented once at
// creation time in createGroup. It is never touched here, so the aggregate
// "how many groups have used this" stat survives independently of deleting
// the underlying group data.
exports.cleanupExpiredGroups = onSchedule("every 60 minutes", async () => {
  const db   = admin.database();
  const snap = await db.ref("groups").get();
  if (!snap.exists()) return;

  const now = Date.now();
  const updates = {};
  let expiredCount = 0, stuckCount = 0;

  snap.forEach((child) => {
    const group = child.val();
    const age   = now - (group.createdAt || 0);
    if (group.state === "loading" && age > STUCK_TTL_MS) {
      updates[child.key] = null;
      stuckCount++;
    } else if (age > GROUP_TTL_MS) {
      updates[child.key] = null;
      expiredCount++;
    }
  });

  if (Object.keys(updates).length > 0) {
    await db.ref("groups").update(updates);
  }
  console.log(`cleanupExpiredGroups: removed ${expiredCount} expired groups, ${stuckCount} stuck reservations`);
});
