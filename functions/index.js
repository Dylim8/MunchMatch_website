const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions");

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

exports.fetchRestaurants = onCall({ secrets: [PLACES_KEY] }, async (request) => {
  const {
    location,
    distance,
    mealtime,
    price,
    cuisine,
    rating,
    dietary,
    openNow,
  } = request.data;

  if (!location || !mealtime) {
    throw new HttpsError("invalid-argument", "Missing location or mealtime.");
  }

  const key          = PLACES_KEY.value();
  const radiusMeters = Math.min((parseInt(distance) || 5) * 1609, 50000);
  const priceLevels  = PRICE_LEVELS.slice(0, parseInt(price) || 2);

  const dietaryPrefix = dietary === "vegan" ? "vegan " : "";
  const textQuery     = `${dietaryPrefix}${mealtime} restaurants in ${location}`;

  const baseBody = {
    textQuery,
    priceLevels,
    locationBias: { circle: { radius: radiusMeters } },
  };

  if (openNow === true) baseBody.openNow = true;
  if (cuisine)          baseBody.includedType = cuisine;
  if (rating)           baseBody.minRating = parseFloat(rating);

  // ── 1. Fetch up to 3 pages (60 results max) ───────────────────────────────
  let places = await fetchAllPages(key, baseBody, 20, 3);

  // ── 2. Fallback: if still thin, retry with minRating relaxed ─────────────
  // Threshold of 10 — below that the swipe deck feels too short to be fun
  if (places.length < 10 && rating && parseFloat(rating) > 3.0) {
    console.log(`Only ${places.length} results with minRating ${rating}, retrying without rating filter`);
    const relaxedBody = { ...baseBody };
    delete relaxedBody.minRating;
    const fallbackPlaces = await fetchAllPages(key, relaxedBody, 20, 2);

    // Merge — keep originals, fill up with fallback results not already in the set
    const existingIds = new Set(places.map(p => p.id));
    const extras      = fallbackPlaces.filter(p => !existingIds.has(p.id));
    places            = [...places, ...extras].slice(0, 20);
  }

  if (!places.length) {
    throw new HttpsError("not-found", "No restaurants found for that location.");
  }

  // ── 3. Resolve photo URIs server-side in parallel ─────────────────────────
  const results = await Promise.all(
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

  return results;
});