const PRIORITY = {
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

class PriorityQueue {
  constructor() {
    this.buckets = {
      [PRIORITY.HIGH]: [],
      [PRIORITY.MEDIUM]: [],
      [PRIORITY.LOW]: [],
    };
    this.seen = new Set();
  }

  static keyForPoint(point) {
    return `${point.lat.toFixed(5)}:${point.lng.toFixed(5)}`;
  }

  enqueue(point, priority = PRIORITY.LOW) {
    if (this.size > 2000) {
      return false;
    }

    const key = PriorityQueue.keyForPoint(point);
    if (this.seen.has(key)) {
      return false;
    }

    this.seen.add(key);
    this.buckets[priority].push({ ...point, key, priority });
    return true;
  }

  dequeue() {
    if (this.buckets[PRIORITY.HIGH].length) {
      return this.buckets[PRIORITY.HIGH].shift();
    }

    if (this.buckets[PRIORITY.MEDIUM].length) {
      return this.buckets[PRIORITY.MEDIUM].shift();
    }

    if (this.buckets[PRIORITY.LOW].length) {
      return this.buckets[PRIORITY.LOW].shift();
    }

    return null;
  }

  get size() {
    return (
      this.buckets[PRIORITY.HIGH].length +
      this.buckets[PRIORITY.MEDIUM].length +
      this.buckets[PRIORITY.LOW].length
    );
  }

  dump() {
    return {
      buckets: {
        [PRIORITY.HIGH]: [...this.buckets[PRIORITY.HIGH]],
        [PRIORITY.MEDIUM]: [...this.buckets[PRIORITY.MEDIUM]],
        [PRIORITY.LOW]: [...this.buckets[PRIORITY.LOW]],
      },
      seen: [...this.seen],
    };
  }

  load(snapshot) {
    if (!snapshot) {
      return;
    }

    this.buckets = {
      [PRIORITY.HIGH]: snapshot.buckets?.[PRIORITY.HIGH] || [],
      [PRIORITY.MEDIUM]: snapshot.buckets?.[PRIORITY.MEDIUM] || [],
      [PRIORITY.LOW]: snapshot.buckets?.[PRIORITY.LOW] || [],
    };
    this.seen = new Set(snapshot.seen || []);
  }

  enqueueMany(points, priority = PRIORITY.LOW) {
    let added = 0;
    for (const point of points) {
      if (this.enqueue(point, priority)) {
        added += 1;
      }
    }
    return added;
  }
}

module.exports = {
  PriorityQueue,
  PRIORITY,
};
