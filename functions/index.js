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

exports.fetchRestaurants = onCall({ secrets: [PLACES_KEY] }, async (request) => {
  const { location, distance, mealtime, price } = request.data;

  if (!location || !mealtime) {
    throw new HttpsError("invalid-argument", "Missing location or mealtime.");
  }

  const key          = PLACES_KEY.value();
  const radiusMeters = Math.min((parseInt(distance) || 5) * 1609, 50000);
  const priceLevels  = PRICE_LEVELS.slice(0, parseInt(price) || 2);

  // ── 1. Text Search — 1 API call for the whole group ───────────────────────
  const searchRes = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type":     "application/json",
      "X-Goog-Api-Key":   key,
      "X-Goog-FieldMask": [
        "places.id",
        "places.displayName",
        "places.rating",
        "places.userRatingCount",
        "places.priceLevel",
        "places.photos",
        "places.formattedAddress",
        "places.googleMapsUri",
      ].join(","),
    },
    body: JSON.stringify({
      textQuery:      `${mealtime} restaurants in ${location}`,
      maxResultCount: 20,
      priceLevels,
      locationBias:   { circle: { radius: radiusMeters } },
    }),
  });

  if (!searchRes.ok) {
    const err = await searchRes.json().catch(() => ({}));
    throw new HttpsError("internal", err?.error?.message || `Places API error ${searchRes.status}`);
  }

  const { places = [] } = await searchRes.json();

  if (!places.length) {
    throw new HttpsError("not-found", "No restaurants found for that location.");
  }

  // ── 2. Resolve photo URIs server-side in parallel ─────────────────────────
  // skipHttpRedirect=true returns a JSON body with a direct CDN photoUri.
  // The browser can load these images with no API key at all.
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
          // Non-fatal — card will render without a photo
        }
      }

      return {
        id:          p.id,
        name:        p.displayName?.text       || "Unknown",
        rating:      p.rating                  || null,
        reviewCount: p.userRatingCount         || 0,
        price:       PRICE_LABEL[p.priceLevel] || null,
        photoUri,
        address:     p.formattedAddress        || "",
        mapsUrl:     p.googleMapsUri           || `https://www.google.com/maps/place/?q=place_id:${p.id}`,
      };
    })
  );

  return results;
});