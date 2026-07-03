// Fetches Google reviews + rating and writes src/config/reviews.generated.json.
//
// Runs as part of `pnpm build`. A daily Vercel Deploy Hook ping triggers a
// rebuild, so reviews stay fresh without any git commits.
//
// Two sources, tried in order:
//   1. Business Profile API  — returns ALL reviews (needs OAuth + API access
//      approval). Used when the GOOGLE_OAUTH_* env vars are set.
//   2. Places API            — returns up to 5 reviews (just needs an API key).
//      Used as a fallback when Business Profile isn't available.
// If neither works, the committed JSON is left untouched so the build never
// breaks. This script never exits non-zero.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "config", "reviews.generated.json");

// --- Places API fallback config ---
const PLACE_ID = process.env.GOOGLE_PLACE_ID || "ChIJrQdHWnrXnUcRXYXRkpcV9EM";
const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY;

// --- Business Profile (OAuth) config ---
const OAUTH = {
  clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
  clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
};
// Optional pin: "accounts/123/locations/456". If unset, the business is auto-discovered.
const LOCATION_OVERRIDE = process.env.GOOGLE_LOCATION_NAME;

const STAR = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

function initialFor(name) {
  const ch = (name || "").trim().match(/\p{L}|\p{N}/u);
  return ch ? ch[0].toUpperCase() : "";
}

// Business Profile returns translated reviews as
// "(Translated by Google) X\n\n(Original) Y" — keep the reviewer's original.
function cleanComment(c) {
  if (!c) return "";
  const i = c.indexOf("(Original)");
  if (i !== -1) return c.slice(i + "(Original)".length).trim();
  return c.replace(/^\(Translated by Google\)\s*/, "").trim();
}

async function gbpAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: OAUTH.clientId,
      client_secret: OAUTH.clientSecret,
      refresh_token: OAUTH.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`token refresh failed: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function gbpJson(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${res.status} ${url}\n${await res.text()}`);
  return res.json();
}

// Find the "accounts/X/locations/Y" path + numeric location id to query.
async function discoverLocation(token) {
  if (LOCATION_OVERRIDE) {
    const id = LOCATION_OVERRIDE.split("/").pop();
    return { reviewsBase: LOCATION_OVERRIDE, locationId: id };
  }
  const accounts =
    (await gbpJson(
      "https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
      token
    )).accounts || [];

  for (const acc of accounts) {
    let pageToken;
    do {
      const url = new URL(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${acc.name}/locations`
      );
      url.searchParams.set("readMask", "name,title");
      url.searchParams.set("pageSize", "100");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const data = await gbpJson(url.toString(), token);
      for (const loc of data.locations || []) {
        // First location of the first account — these credentials manage one business.
        const locId = loc.name.split("/").pop();
        console.log(`[reviews] using location: ${loc.title} (${acc.name}/locations/${locId})`);
        return { reviewsBase: `${acc.name}/locations/${locId}`, locationId: locId };
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  }
  throw new Error("no Business Profile locations found for these credentials");
}

async function fetchFromBusinessProfile() {
  const token = await gbpAccessToken();
  const { reviewsBase } = await discoverLocation(token);

  const all = [];
  let averageRating = null;
  let totalReviewCount = null;
  let pageToken;
  do {
    const url = new URL(`https://mybusiness.googleapis.com/v4/${reviewsBase}/reviews`);
    url.searchParams.set("pageSize", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await gbpJson(url.toString(), token);
    averageRating = data.averageRating ?? averageRating;
    totalReviewCount = data.totalReviewCount ?? totalReviewCount;
    for (const r of data.reviews || []) {
      const name = r.reviewer?.displayName || "Google-Nutzer";
      const text = cleanComment(r.comment);
      if (!text) continue; // skip star-only ratings with no written comment
      all.push({
        name,
        initial: initialFor(name),
        rating: STAR[r.starRating] ?? 5,
        date: (r.createTime || "").slice(0, 10),
        text,
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return {
    source: "business-profile",
    overallRating: averageRating != null ? Math.round(averageRating * 10) / 10 : null,
    totalReviews: totalReviewCount,
    reviews: all,
  };
}

async function fetchFromPlaces() {
  const url = `https://places.googleapis.com/v1/places/${PLACE_ID}?languageCode=de`;
  const res = await fetch(url, {
    headers: {
      "X-Goog-Api-Key": PLACES_KEY,
      "X-Goog-FieldMask": "id,displayName,rating,userRatingCount,reviews",
    },
  });
  if (!res.ok) throw new Error(`Places API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const reviews = (data.reviews || []).map((r) => {
    const name = r.authorAttribution?.displayName || "Google-Nutzer";
    return {
      name,
      initial: initialFor(name),
      rating: r.rating ?? 5,
      date: (r.publishTime || "").slice(0, 10),
      text: (r.originalText?.text ?? r.text?.text ?? "").trim(),
    };
  });
  return {
    source: "places",
    overallRating: data.rating ?? null,
    totalReviews: data.userRatingCount ?? null,
    reviews,
  };
}

async function main() {
  let result = null;

  if (OAUTH.clientId && OAUTH.clientSecret && OAUTH.refreshToken) {
    try {
      result = await fetchFromBusinessProfile();
    } catch (e) {
      console.warn(`[reviews] Business Profile failed: ${e.message}`);
    }
  }

  if ((!result || result.reviews.length === 0) && PLACES_KEY) {
    try {
      result = await fetchFromPlaces();
    } catch (e) {
      console.warn(`[reviews] Places API failed: ${e.message}`);
    }
  }

  if (!result || result.reviews.length === 0) {
    console.warn("[reviews] No source available — keeping existing reviews.generated.json.");
    return;
  }

  const output = {
    lastUpdated: new Date().toISOString(),
    source: result.source,
    overallRating: result.overallRating,
    totalReviews: result.totalReviews,
    reviews: result.reviews,
  };
  await writeFile(OUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(
    `[reviews] Wrote ${result.reviews.length} reviews · rating ${output.overallRating} · ${output.totalReviews} total (source: ${result.source})`
  );
}

main().catch((err) => {
  console.warn(`[reviews] Unexpected error, keeping existing data: ${err.message}`);
});
