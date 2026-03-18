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
}

module.exports = {
  PriorityQueue,
  PRIORITY,
};
