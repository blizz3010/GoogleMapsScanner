const { initDb, insertBusinesses, closeDb } = require('./db');
const { PlacesClient } = require('./places');
const { PriorityQueue, PRIORITY } = require('./queue');

const SCAN_RADIUS_METERS = 1500;
const NEIGHBOR_SPACING = 0.01;

const SEED_LOCATIONS = [
  { name: 'Downtown Orlando', lat: 28.5383, lng: -81.3792 },
  { name: 'International Drive', lat: 28.4442, lng: -81.4716 },
  { name: 'Lake Nona', lat: 28.3852, lng: -81.2428 },
  { name: 'Winter Park', lat: 28.5999, lng: -81.3392 },
  { name: 'UCF Area', lat: 28.6024, lng: -81.2001 },
];

function createNeighbors(point) {
  return [
    { lat: point.lat + NEIGHBOR_SPACING, lng: point.lng, source: point.name || point.key, direction: 'north' },
    { lat: point.lat - NEIGHBOR_SPACING, lng: point.lng, source: point.name || point.key, direction: 'south' },
    { lat: point.lat, lng: point.lng + NEIGHBOR_SPACING, source: point.name || point.key, direction: 'east' },
    { lat: point.lat, lng: point.lng - NEIGHBOR_SPACING, source: point.name || point.key, direction: 'west' },
  ];
}

async function run() {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const maxApiCalls = Number(process.env.MAX_API_CALLS || 3000);

  const placesClient = new PlacesClient({ apiKey, maxCalls: maxApiCalls });
  const queue = new PriorityQueue();

  const seenPlaceIds = new Set();
  let totalStored = 0;

  await initDb();

  for (const seed of SEED_LOCATIONS) {
    queue.enqueue(seed, PRIORITY.HIGH);
  }

  while (queue.size > 0) {
    const current = queue.dequeue();
    if (!current) {
      break;
    }

    console.log(`Scanning: ${current.name || current.key} (${current.lat}, ${current.lng}) | queue=${queue.size}`);

    try {
      const { results, limitReached } = await placesClient.fetchAllNearbyPages({
        lat: current.lat,
        lng: current.lng,
        radius: SCAN_RADIUS_METERS,
      });

      const newResults = [];
      for (const place of results) {
        if (place.place_id && !seenPlaceIds.has(place.place_id)) {
          seenPlaceIds.add(place.place_id);
          newResults.push(place);
        }
      }

      const { insertedCount } = await insertBusinesses(newResults);
      totalStored += insertedCount;

      console.log(
        `Found=${results.length}, uniqueNew=${newResults.length}, totalStored=${totalStored}, apiCalls=${placesClient.apiCallsUsed}/${maxApiCalls}`
      );

      if (limitReached) {
        console.log('API call limit reached. Stopping scan.');
        break;
      }

      if (results.length > 20) {
        for (const neighbor of createNeighbors(current)) {
          queue.enqueue(neighbor, PRIORITY.HIGH);
        }
      } else if (results.length <= 5) {
        for (const neighbor of createNeighbors(current)) {
          queue.enqueue(neighbor, PRIORITY.LOW);
        }
      } else {
        for (const neighbor of createNeighbors(current)) {
          queue.enqueue(neighbor, PRIORITY.MEDIUM);
        }
      }
    } catch (error) {
      console.error(`Scan failed at ${current.key}: ${error.message}`);
      console.error('Continuing with next location...');
    }

    if (placesClient.apiCallsUsed >= maxApiCalls) {
      console.log('Max API calls exhausted. Stopping scan.');
      break;
    }
  }

  await closeDb();
  console.log(`Scan complete. Total businesses stored: ${totalStored}. API calls used: ${placesClient.apiCallsUsed}.`);
}

run().catch(async (error) => {
  console.error('Fatal scanner error:', error);
  try {
    await closeDb();
  } catch (_) {
    // Ignore close errors.
  }
  process.exit(1);
});
