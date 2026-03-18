const GOOGLE_PLACES_URL = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';

const DEFAULT_MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS || 0);
const DEFAULT_MAX_REQUESTS_PER_SECOND = Number(process.env.MAX_REQUESTS_PER_SECOND || 0);
const DEFAULT_NEXT_PAGE_DELAY_MS = Number(process.env.NEXT_PAGE_DELAY_MS || 1500);
const MAX_RETRIES = 3;

const fetchClient =
  typeof fetch === 'function'
    ? fetch
    : (...args) => import('node-fetch').then(({ default: nodeFetch }) => nodeFetch(...args));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class PlacesClient {
  constructor({
    apiKey,
    maxCalls = 300,
    minDelayMs = DEFAULT_MIN_DELAY_MS,
    maxRequestsPerSecond = DEFAULT_MAX_REQUESTS_PER_SECOND,
    nextPageDelayMs = DEFAULT_NEXT_PAGE_DELAY_MS,
  }) {
    if (!apiKey) {
      throw new Error('Missing GOOGLE_PLACES_API_KEY environment variable');
    }

    this.apiKey = apiKey;
    this.maxCalls = maxCalls;
    this.apiCallsUsed = 0;
    this.lastRequestAt = 0;
    this.recentRequests = [];
    this.minDelayMs = minDelayMs;
    this.maxRequestsPerSecond = maxRequestsPerSecond;
    this.nextPageDelayMs = nextPageDelayMs;
  }

  async enforceRateLimit() {
    const now = Date.now();
    const sinceLast = now - this.lastRequestAt;

    if (this.minDelayMs > 0 && sinceLast < this.minDelayMs) {
      await sleep(this.minDelayMs - sinceLast);
    }

    const oneSecondAgo = Date.now() - 1000;
    this.recentRequests = this.recentRequests.filter((ts) => ts > oneSecondAgo);

    if (this.maxRequestsPerSecond > 0 && this.recentRequests.length >= this.maxRequestsPerSecond) {
      const oldest = this.recentRequests[0];
      const waitFor = 1000 - (Date.now() - oldest);
      if (waitFor > 0) {
        await sleep(waitFor);
      }
    }
  }

  async requestNearby({ lat, lng, radius, pageToken, category }) {
    if (this.apiCallsUsed >= this.maxCalls) {
      return { results: [], hasMore: false, limitReached: true };
    }

    await this.enforceRateLimit();

    const params = new URLSearchParams({
      key: this.apiKey,
      radius: String(radius),
    });

    if (pageToken) {
      params.set('pagetoken', pageToken);
    } else {
      params.set('location', `${lat},${lng}`);
      if (category) {
        params.set('keyword', category);
      }
    }

    const url = `${GOOGLE_PLACES_URL}?${params.toString()}`;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const response = await fetchClient(url);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        if (data.status === 'INVALID_REQUEST' && pageToken && attempt < MAX_RETRIES) {
          const retryDelay = 1000 * (attempt + 1);
          await sleep(retryDelay);
          continue;
        }

        if (!['OK', 'ZERO_RESULTS'].includes(data.status)) {
          if (attempt < MAX_RETRIES) {
            await sleep(1000 * attempt);
            continue;
          }
          throw new Error(`Google Places API error: ${data.status}`);
        }

        this.apiCallsUsed += 1;
        this.lastRequestAt = Date.now();
        this.recentRequests.push(this.lastRequestAt);

        return {
          results: data.results || [],
          hasMore: Boolean(data.next_page_token),
          nextPageToken: data.next_page_token,
          limitReached: false,
        };
      } catch (error) {
        if (attempt === MAX_RETRIES) {
          throw error;
        }
        await sleep(1000 * attempt);
      }
    }

    return { results: [], hasMore: false, limitReached: false };
  }

  async fetchAllNearbyPages({ lat, lng, radius = 1500, category }) {
    const combined = [];

    let pageToken = null;
    let hasMore = true;
    let emptyPageRetryUsed = false;

    while (hasMore) {
      if (this.apiCallsUsed >= this.maxCalls) {
        return { results: combined, limitReached: true };
      }

      const page = await this.requestNearby({ lat, lng, radius, pageToken, category });
      if (page.limitReached) {
        return { results: combined, limitReached: true };
      }

      if (page.results.length === 0 && page.hasMore) {
        if (!emptyPageRetryUsed) {
          emptyPageRetryUsed = true;
          await sleep(this.nextPageDelayMs);
          continue;
        }
        break;
      }

      combined.push(...page.results);
      hasMore = page.hasMore;
      pageToken = page.nextPageToken || null;

      if (hasMore) {
        await sleep(this.nextPageDelayMs);
      }
    }

    return { results: combined, limitReached: false };
  }
}

module.exports = {
  PlacesClient,
  sleep,
};
