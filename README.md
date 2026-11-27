# GoogleMapsScanner

Node.js script that scans Google Places around Orlando, stores businesses in PostgreSQL, and expands outward from points that return more results. `scanner.js` is the whole program. `places.js`, `queue.js`, and `db.js` are the libraries it loads.

There is no `package.json`, no npm script, and no CLI. The process reads three environment variables and then runs until the queue is empty or the API call budget stops it.

## How the pieces fit

`scanner.js` calls `run()` as soon as it is loaded.

1. `initDb()` creates the `businesses` table when it is missing.
2. Five Orlando seed points are enqueued at high priority.
3. While the queue is not empty, the loop dequeues one point, requests every Nearby Search page for it, inserts places whose `place_id` is new to this process, and enqueues the four neighboring points.
4. `closeDb()` runs on the way out. A fatal error does the same and then `process.exit(1)`.

| File | Exports | Role |
| --- | --- | --- |
| `scanner.js` | none | Seeds, loop, neighbor expansion, logging. |
| `places.js` | `PlacesClient`, `sleep` | Nearby Search requests, retries, pacing, call budget. |
| `queue.js` | `PriorityQueue`, `PRIORITY` | High, medium, and low FIFO buckets plus a coordinate seen-set. |
| `db.js` | `initDb`, `insertBusinesses`, `closeDb` | `pg` pool and inserts. |

`PRIORITY` is `HIGH = 3`, `MEDIUM = 2`, `LOW = 1`. Dequeue drains high, then medium, then low. Any other priority is not a bucket and throws on `enqueue`.

## Prerequisites

- Node.js 18 or newer. `places.js` calls global `fetch` and does not load a polyfill. The repo has no `engines` field.
- PostgreSQL, reached through `DATABASE_URL`.
- The `pg` package resolvable by `require('pg')`. This repo does not declare or pin a version.

## Environment variables

Names only. The code reads these and does not read `process.argv`.

| Variable | Required | Where | What the code does with it |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | `db.js` | `new Pool({ connectionString: process.env.DATABASE_URL })`. No other pool options. The value is not checked before the first query. |
| `GOOGLE_PLACES_API_KEY` | yes | `scanner.js` | Passed into `PlacesClient` and sent as the `key` query parameter. A missing or empty key throws `Missing GOOGLE_PLACES_API_KEY environment variable`. |
| `MAX_API_CALLS` | no | `scanner.js` | `Number(process.env.MAX_API_CALLS \|\| 3000)`. Passed as `maxCalls`. The constructor default is also 3000. |

Requests go to `https://maps.googleapis.com/maps/api/place/nearbysearch/json`.

The first page sends `key`, `location` (`lat,lng`), and `radius`. A later page sends `key`, `radius`, and `pagetoken`. The client sets no `type`, `keyword`, `language`, or `rankby`.

## How to run

Install `pg` so Node can resolve it, export the two required variables, then from this directory:

```bash
node scanner.js
```

`MAX_API_CALLS` is optional. Loading `scanner.js` through `require` also starts `run()`. The scan function is not exported.

Logs per point: `Scanning: <name or key> (<lat>, <lng>) | queue=<n>`, then `Found=..., uniqueNew=..., totalStored=..., apiCalls=<used>/<max>`. The closing line is `Scan complete. Total businesses stored: <n>. API calls used: <n>.` An error on one point logs `Scan failed at <key>` and continues. That point is not put back, and its neighbors are not added.

## Database

`initDb()` runs this statement and does nothing when `businesses` already exists. It does not migrate an older shape.

```sql
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
```

`insertBusinesses` writes one parameterized `INSERT ... ON CONFLICT (place_id) DO NOTHING RETURNING place_id`. `insertedCount` is `rowCount` from that statement (rows actually inserted). `created_at` stays on the column default.

| Column | Taken from |
| --- | --- |
| `place_id` | `place.place_id` |
| `name` | `place.name` |
| `category` | `place.types[0]`, or null when `types` is missing or empty |
| `lat`, `lng` | `place.geometry.location.lat` and `.lng` |
| `rating` | `place.rating`, or null |
| `review_count` | `place.user_ratings_total`, or null |
| `address` | `place.vicinity`, else `place.formatted_address`, else null |

A place with no `place_id`, no `name`, or a null `lat` or `lng` is left out of the insert. `lat` or `lng` of `0` is kept.

## Scan behavior

Hard-coded in `scanner.js`:

- Radius `1500` meters (`SCAN_RADIUS_METERS`). `fetchAllNearbyPages` defaults to the same radius.
- Neighbor step `0.01` degrees north, south, east, and west (`NEIGHBOR_SPACING`).
- No bounding box and no maximum queue length.

Seeds, all enqueued at high priority:

| Name | Latitude | Longitude |
| --- | --- | --- |
| Downtown Orlando | 28.5383 | -81.3792 |
| International Drive | 28.4442 | -81.4716 |
| Lake Nona | 28.3852 | -81.2428 |
| Winter Park | 28.5999 | -81.3392 |
| UCF Area | 28.6024 | -81.2001 |

Neighbor priority uses `results.length` for that point after all pages are combined, before the place-id filter:

| Combined results | Priority |
| --- | --- |
| more than 20 | high |
| 6 through 20 | medium |
| 5 or fewer | low |

The queue key is `` `${lat.toFixed(5)}:${lng.toFixed(5)}` ``. A key that was already enqueued is ignored, including when a later neighbor would have used a higher priority.

`seenPlaceIds` in the scanner skips a `place_id` already handled in this process. A `place_id` already stored in Postgres is skipped by the unique constraint, and it does not increase `insertedCount`.

The loop also stops when a call would start with `apiCallsUsed >= maxCalls`. Pages already fetched for that point are still inserted. Neighbors of that point are not enqueued. The same comparison runs again after each point.

## Rate limit and call budget

| Constant | Value | Behavior |
| --- | --- | --- |
| `MIN_DELAY_MS` | 400 | Wait so this request starts at least 400 ms after `lastRequestAt`. |
| `MAX_REQUESTS_PER_SECOND` | 2 | If two recorded timestamps still fall inside the last 1000 ms, wait until the oldest is outside that window. |
| `NEXT_PAGE_DELAY_MS` | 2000 | Pause before the next page. |
| `MAX_RETRIES` | 3 | Attempts per page. |
| retry pause | `1000 * attempt` ms | Used when a try fails and attempts remain. |
| `maxCalls` | 3000 by default | See `MAX_API_CALLS`. |

`apiCallsUsed` increases by one for every `fetch` that returns a response, including HTTP errors, non-OK Places statuses, and retries. The code never states a dollar price. A `fetch` that throws before a response does not increase it. `lastRequestAt` is set from that same response time. Retries inside one page do not call `enforceRateLimit` again.

`INVALID_REQUEST` on a page that has a `pagetoken` is retried while attempts remain. Any status other than `OK` or `ZERO_RESULTS` is retried the same way, then thrown as `Google Places API error: <status>`. A non-OK HTTP response throws `HTTP <status>` and follows the same retry loop. Pagination stops when `next_page_token` is absent. There is no page cap in the code.

## Known limitations

- Seeds, radius, and the neighbor step are constants. The city and the grid are fixed in source.
- Every scanned point enqueues four neighbors. Density only changes priority, so a dense area keeps filling the high bucket ahead of medium and low points.
- Neighbor objects set `source` and `direction`. Nothing else reads them.
- `initDb` will not alter a `businesses` table that already exists. There is no test suite and no signal handler, so a kill during the loop can skip `closeDb()`.

## Known issues

- **A non-numeric `MAX_API_CALLS` disables the stop.** `Number(process.env.MAX_API_CALLS || 3000)` turns an unset or empty value into 3000. A non-numeric string becomes `NaN`, and both `apiCallsUsed >= maxCalls` checks are then false, so the budget never stops the scan. The string `0` is numeric zero and stops before the first request.
- **Retries can pass the budget.** `requestNearby` checks the cap once, then each of up to three attempts that receive a response increments `apiCallsUsed`.
- **Thin places are counted, then dropped.** The scanner adds `place_id` to `seenPlaceIds` before insert. `insertBusinesses` then skips a row with no `name` or no coordinates and does not say which ids it skipped. `uniqueNew` includes those rows. `totalStored` does not. The id is not tried again in this process.
- **The final "Total businesses stored" line is this run's insert count.** It is the sum of `insertedCount`. Rows already in the table, conflict skips, and rows dropped for missing fields are not included.
