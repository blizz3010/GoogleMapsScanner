const { initDb, insertBusinesses, closeDb } = require('./db');
const { PlacesClient } = require('./places');

const DEFAULT_RADIUS = Number(process.env.SCAN_RADIUS_METERS || 1500);
const DEFAULT_MAX_API_CALLS = Number(process.env.MAX_API_CALLS || 3000);
const LOOP_FOREVER = String(process.env.CONTINUOUS_SCAN || 'true').toLowerCase() === 'true';

const DEFAULT_CATEGORIES = (process.env.SCAN_CATEGORIES ||
  'restaurant,barbershop,dentist,lawyer,real_estate_agency').split(',').map((x) => x.trim()).filter(Boolean);

const FLORIDA_BOUNDS = {
  minLat: Number(process.env.MIN_LAT || 24.396308),
  maxLat: Number(process.env.MAX_LAT || 31.000888),
  minLng: Number(process.env.MIN_LNG || -87.634938),
  maxLng: Number(process.env.MAX_LNG || -79.974307),
};

const TILE_STEP = Number(process.env.TILE_STEP || 0.05);

function parseNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function generateTiles({ minLat, maxLat, minLng, maxLng, step }) {
  const tiles = [];
  for (let lat = minLat; lat <= maxLat; lat += step) {
    for (let lng = minLng; lng <= maxLng; lng += step) {
      tiles.push({ lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) });
    }
  }
  return tiles;
}

function enrichLocation(place) {
  const formatted = place.formatted_address || place.vicinity || '';
  const parts = formatted.split(',').map((p) => p.trim());
  const stateMatch = formatted.match(/\b([A-Z]{2})\b/);
  return {
    ...place,
    city: parts.length >= 3 ? parts[parts.length - 3] : null,
    state: stateMatch ? stateMatch[1] : null,
    last_seen: new Date().toISOString(),
  };
}

async function scanTile({ placesClient, tile, radius, categories }) {
  const seenInTile = new Set();
  let tileInserted = 0;
  const perCategory = [];

  for (const category of categories) {
    if (placesClient.apiCallsUsed >= placesClient.maxCalls) {
      break;
    }

    const { results, limitReached } = await placesClient.fetchAllNearbyPages({
      lat: tile.lat,
      lng: tile.lng,
      radius,
      category,
    });

    const fresh = [];
    for (const place of results) {
      if (!place.place_id || seenInTile.has(place.place_id)) {
        continue;
      }
      seenInTile.add(place.place_id);
      fresh.push(enrichLocation(place));
    }

    const { insertedCount } = await insertBusinesses(fresh);
    tileInserted += insertedCount;
    perCategory.push({ category, found: results.length, inserted: insertedCount });

    console.log(
      JSON.stringify({
        event: 'tile_category_scanned',
        tile,
        category,
        found: results.length,
        inserted: insertedCount,
        totalApiCalls: placesClient.apiCallsUsed,
      })
    );

    if (limitReached) {
      break;
    }
  }

  return { tile, tileInserted, perCategory };
}

async function runTileWorker({
  startLat,
  startLng,
  radius = DEFAULT_RADIUS,
  categories = DEFAULT_CATEGORIES,
  maxApiCalls = DEFAULT_MAX_API_CALLS,
  tiles,
}) {
  const placesClient = new PlacesClient({
    apiKey: process.env.GOOGLE_PLACES_API_KEY,
    maxCalls: maxApiCalls,
  });

  const tilesToProcess =
    tiles && tiles.length
      ? tiles
      : startLat != null && startLng != null
        ? [{ lat: startLat, lng: startLng }]
        : generateTiles({ ...FLORIDA_BOUNDS, step: TILE_STEP });

  await initDb();

  let totalInserted = 0;
  let iteration = 0;

  try {
    while (LOOP_FOREVER || iteration === 0) {
      for (const tile of tilesToProcess) {
        if (placesClient.apiCallsUsed >= placesClient.maxCalls) {
          console.log('Max API calls reached for worker. Exiting current run.');
          return { totalInserted, apiCallsUsed: placesClient.apiCallsUsed, iterations: iteration };
        }

        const result = await scanTile({ placesClient, tile, radius, categories });
        totalInserted += result.tileInserted;

        console.log(
          JSON.stringify({
            event: 'tile_complete',
            tile: result.tile,
            tileInserted: result.tileInserted,
            totalInserted,
            apiCallsUsed: placesClient.apiCallsUsed,
          })
        );
      }

      iteration += 1;
      console.log(
        JSON.stringify({
          event: 'worker_iteration_complete',
          iteration,
          tilesProcessed: tilesToProcess.length,
          totalInserted,
          apiCallsUsed: placesClient.apiCallsUsed,
        })
      );

      if (!LOOP_FOREVER) {
        break;
      }
    }

    return { totalInserted, apiCallsUsed: placesClient.apiCallsUsed, iterations: iteration };
  } finally {
    await closeDb();
  }
}

if (require.main === module) {
  const cliLat = parseNumber(process.argv[2]);
  const cliLng = parseNumber(process.argv[3]);
  const cliRadius = parseNumber(process.argv[4]) || DEFAULT_RADIUS;

  runTileWorker({ startLat: cliLat, startLng: cliLng, radius: cliRadius })
    .then((summary) => {
      console.log(JSON.stringify({ event: 'worker_finished', ...summary }));
    })
    .catch((error) => {
      console.error('Fatal scanner error:', error);
      process.exit(1);
    });
}

module.exports = {
  generateTiles,
  scanTile,
  runTileWorker,
};
