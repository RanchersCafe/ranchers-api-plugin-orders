function clone(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

function comparable(value) {
  if (value instanceof Date) return value.getTime();
  if (value && typeof value.toHexString === "function") return value.toHexString();
  return value;
}

function getPath(document, path) {
  return path.split(".").reduce((value, key) => value?.[key], document);
}

function setPath(document, path, value) {
  const keys = path.split(".");
  let target = document;
  keys.slice(0, -1).forEach((key) => {
    if (target[key] === undefined || target[key] === null) {
      target[key] = /^\d+$/.test(keys[keys.indexOf(key) + 1] || "") ? [] : {};
    }
    target = target[key];
  });
  target[keys[keys.length - 1]] = clone(value);
}

function unsetPath(document, path) {
  const keys = path.split(".");
  const parent = keys.slice(0, -1).reduce((value, key) => value?.[key], document);
  if (parent) delete parent[keys[keys.length - 1]];
}

function matchesCondition(actual, condition) {
  if (!condition || typeof condition !== "object" || condition instanceof Date || Array.isArray(condition)) {
    return comparable(actual) === comparable(condition);
  }

  return Object.entries(condition).every(([operator, expected]) => {
    if (operator === "$ne") return comparable(actual) !== comparable(expected);
    if (operator === "$exists") return expected ? actual !== undefined : actual === undefined;
    if (operator === "$lte") return comparable(actual) <= comparable(expected);
    if (operator === "$gte") return comparable(actual) >= comparable(expected);
    if (operator === "$in") {
      const values = Array.isArray(expected) ? expected.map(comparable) : [];
      if (Array.isArray(actual)) return actual.map(comparable).some((value) => values.includes(value));
      return values.includes(comparable(actual));
    }
    return false;
  });
}

function matches(document, query = {}) {
  return Object.entries(query).every(([key, condition]) => {
    if (key === "$or") return condition.some((branch) => matches(document, branch));
    return matchesCondition(getPath(document, key), condition);
  });
}

function applyUpdate(document, update) {
  Object.entries(update.$set || {}).forEach(([path, value]) => setPath(document, path, value));
  Object.keys(update.$unset || {}).forEach((path) => unsetPath(document, path));
  Object.entries(update.$inc || {}).forEach(([path, value]) => {
    setPath(document, path, Number(getPath(document, path) || 0) + Number(value));
  });
}

class Cursor {
  constructor(documents) {
    this.documents = documents;
  }

  sort(spec = {}) {
    const entries = Object.entries(spec);
    this.documents.sort((left, right) => {
      for (const [path, direction] of entries) {
        const a = comparable(getPath(left, path));
        const b = comparable(getPath(right, path));
        if (a < b) return -1 * direction;
        if (a > b) return 1 * direction;
      }
      return 0;
    });
    return this;
  }

  limit(value) {
    this.documents = this.documents.slice(0, value);
    return this;
  }

  async toArray() {
    return this.documents.map(clone);
  }
}

export class InMemoryCollection {
  constructor(documents = []) {
    this.documents = documents.map(clone);
  }

  async findOne(query) {
    const document = this.documents.find((item) => matches(item, query));
    return document ? clone(document) : null;
  }

  find(query) {
    return new Cursor(this.documents.filter((item) => matches(item, query)).map(clone));
  }

  async updateOne(query, update) {
    const document = this.documents.find((item) => matches(item, query));
    if (!document) return { matchedCount: 0, modifiedCount: 0 };
    applyUpdate(document, update);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async findOneAndUpdate(query, update) {
    const document = this.documents.find((item) => matches(item, query));
    if (!document) return { value: null };
    applyUpdate(document, update);
    return { value: clone(document) };
  }

  snapshot() {
    return this.documents.map(clone);
  }
}
