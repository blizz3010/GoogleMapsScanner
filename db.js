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
}

function normalizeBusiness(place) {
  return {
    place_id: place.place_id,
    name: place.name || null,
    category: place.types && place.types.length ? place.types[0] : null,
    lat: place.geometry?.location?.lat,
    lng: place.geometry?.location?.lng,
    rating: place.rating ?? null,
    review_count: place.user_ratings_total ?? null,
    address: place.vicinity || place.formatted_address || null,
  };
}

async function insertBusinesses(places) {
  if (!places.length) {
    return { insertedCount: 0, placeIds: [] };
  }

  const values = [];
  const placeholders = [];

  places.forEach((place, index) => {
    const business = normalizeBusiness(place);
    if (!business.place_id || business.lat == null || business.lng == null || !business.name) {
      return;
    }

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

  if (!placeholders.length) {
    return { insertedCount: 0, placeIds: [] };
  }

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
  return {
    insertedCount: result.rowCount,
    placeIds: result.rows.map((row) => row.place_id),
  };
}

async function closeDb() {
  await pool.end();
}

module.exports = {
  initDb,
  insertBusinesses,
  closeDb,
};
