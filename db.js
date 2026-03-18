const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS businesses (
      id BIGSERIAL PRIMARY KEY,
      place_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT,
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      rating DOUBLE PRECISION,
      review_count INTEGER,
      address TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_businesses_lat_lng
    ON businesses(lat, lng);
  `);
  await pool.query(`
    ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS price_level INTEGER,
    ADD COLUMN IF NOT EXISTS city TEXT,
    ADD COLUMN IF NOT EXISTS state TEXT,
    ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;
  `);
}

function normalizeBusiness(place) {
  const name = typeof place.name === 'string' ? place.name.trim().slice(0, 512) : null;
  const category = place.types?.[0] || 'unknown';
  const lat = Number(place.geometry?.location?.lat);
  const lng = Number(place.geometry?.location?.lng);
  const addressSource = place.vicinity || place.formatted_address || null;
  const address = typeof addressSource === 'string' ? addressSource.trim().slice(0, 1024) : null;
  const city = typeof place.city === 'string' ? place.city.trim().slice(0, 128) : null;
  const state = typeof place.state === 'string' ? place.state.trim().slice(0, 128) : null;
  const lastSeen = place.last_seen || new Date().toISOString();

  return {
    place_id: place.place_id,
    name,
    category,
    lat,
    lng,
    rating: place.rating ?? null,
    review_count: place.user_ratings_total ?? null,
    address,
    price_level: Number.isFinite(place.price_level) ? place.price_level : null,
    city,
    state,
    last_seen: lastSeen,
  };
}

async function insertBusinesses(places) {
  if (!places.length) {
    return { insertedCount: 0, placeIds: [] };
  }

  const filtered = [];
  for (const place of places) {
    const business = normalizeBusiness(place);
    if (!business.place_id || !business.name || !Number.isFinite(business.lat) || !Number.isFinite(business.lng)) {
      continue;
    }
    filtered.push(business);
  }

  if (!filtered.length) {
    return { insertedCount: 0, placeIds: [] };
  }

  const BATCH_SIZE = 100;
  let insertedCount = 0;
  const placeIds = [];

  for (let i = 0; i < filtered.length; i += BATCH_SIZE) {
    const chunk = filtered.slice(i, i + BATCH_SIZE);
    const values = [];
    const placeholders = [];

    chunk.forEach((business) => {
      const offset = values.length;
      values.push(
        business.place_id,
        business.name,
        business.category,
        business.lat,
        business.lng,
        business.rating,
        business.review_count,
        business.address,
        business.price_level,
        business.city,
        business.state,
        business.last_seen
      );

      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12})`
      );
    });

    const query = `
      INSERT INTO businesses (
        place_id,
        name,
        category,
        lat,
        lng,
        rating,
        review_count,
        address,
        price_level,
        city,
        state,
        last_seen
      ) VALUES ${placeholders.join(', ')}
      ON CONFLICT (place_id) DO UPDATE
      SET
        rating = EXCLUDED.rating,
        review_count = EXCLUDED.review_count,
        address = EXCLUDED.address,
        category = COALESCE(EXCLUDED.category, businesses.category),
        price_level = COALESCE(EXCLUDED.price_level, businesses.price_level),
        city = COALESCE(EXCLUDED.city, businesses.city),
        state = COALESCE(EXCLUDED.state, businesses.state),
        last_seen = EXCLUDED.last_seen
      RETURNING place_id;
    `;

    const result = await pool.query(query, values);
    insertedCount += result.rowCount;
    placeIds.push(...result.rows.map((row) => row.place_id));
  }

  return { insertedCount, placeIds };
}

async function closeDb() {
  await pool.end();
}

module.exports = {
  initDb,
  insertBusinesses,
  closeDb,
};
