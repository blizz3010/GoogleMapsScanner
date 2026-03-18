const fs = require('fs');
const path = require('path');
const { initDb, insertBusinesses, closeDb } = require('./db');
const { PlacesClient } = require('./places');
const { PriorityQueue, PRIORITY } = require('./queue');

const SCAN_RADIUS_METERS = 1500;
const NEIGHBOR_SPACING = 0.015;
const STATE_FILE = path.join(__dirname, 'state.json');

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

function saveState({ queue, visitedLocations, apiCallsUsed }) {
  const state = {
    queue: queue.dump(),
    visitedLocations: [...visitedLocations],
    apiCallsUsed,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

async function run() {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const maxApiCalls = Number(process.env.MAX_API_CALLS || 300);

  const placesClient = new PlacesClient({ apiKey, maxCalls: maxApiCalls });
  const queue = new PriorityQueue();
  const visitedLocations = new Set();

  const seenPlaceIds = new Set();
  let totalStored = 0;
  let scansProcessed = 0;

  await initDb();

  const restoredState = loadState();
  if (restoredState) {
    queue.load(restoredState.queue);
    for (const key of restoredState.visitedLocations || []) {
      visitedLocations.add(key);
    }
    placesClient.apiCallsUsed = Number(restoredState.apiCallsUsed || 0);
    console.log(
      JSON.stringify({
        event: 'state_loaded',
        queueSize: queue.size,
        visitedLocations: visitedLocations.size,
        apiCallsUsed: placesClient.apiCallsUsed,
      })
    );
  } else {
    for (const seed of SEED_LOCATIONS) {
      queue.enqueue(seed, PRIORITY.HIGH);
    }
  }

  while (queue.size > 0) {
    if (placesClient.apiCallsUsed >= maxApiCalls) {
      console.log('Max API calls exhausted. Stopping scan.');
      break;
    }

    const current = queue.dequeue();
    if (!current) {
      break;
    }

    const locationKey = `${current.lat.toFixed(4)},${current.lng.toFixed(4)}`;
    if (visitedLocations.has(locationKey)) {
      continue;
    }
    visitedLocations.add(locationKey);

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
      scansProcessed += 1;

      console.log(
        `Found=${results.length}, uniqueNew=${newResults.length}, totalStored=${totalStored}, apiCalls=${placesClient.apiCallsUsed}/${maxApiCalls}`
      );

      if (scansProcessed % 10 === 0) {
        console.log(
          JSON.stringify({
            event: 'scan_progress',
            scansProcessed,
            queueSize: queue.size,
            visitedLocations: visitedLocations.size,
            apiCallsUsed: placesClient.apiCallsUsed,
            insertedCount,
            totalStored,
          })
        );
      }

      if (scansProcessed % 20 === 0) {
        saveState({ queue, visitedLocations, apiCallsUsed: placesClient.apiCallsUsed });
      }

      if (limitReached) {
        console.log('API call limit reached. Stopping scan.');
        break;
      }

      if (queue.size > 1000) {
        continue;
      }

      if (results.length > 20 && queue.size < 500) {
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

  saveState({ queue, visitedLocations, apiCallsUsed: placesClient.apiCallsUsed });
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
