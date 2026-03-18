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
}

function normalizeBusiness(place) {
  const name = typeof place.name === 'string' ? place.name.trim().slice(0, 512) : null;
  const category = place.types?.[0] || 'unknown';
  const lat = Number(place.geometry?.location?.lat);
  const lng = Number(place.geometry?.location?.lng);
  const addressSource = place.vicinity || place.formatted_address || null;
  const address = typeof addressSource === 'string' ? addressSource.trim().slice(0, 1024) : null;

  return {
    place_id: place.place_id,
    name,
    category,
    lat,
    lng,
    rating: place.rating ?? null,
    review_count: place.user_ratings_total ?? null,
    address,
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
        business.address
      );

      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`
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
        address
      ) VALUES ${placeholders.join(', ')}
      ON CONFLICT (place_id) DO NOTHING
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
