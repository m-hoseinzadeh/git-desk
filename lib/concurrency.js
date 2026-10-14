/**
 * Run an async function over items with at most `limit` running at once
 * @param {Array} items - Items to process
 * @param {number} limit - Maximum concurrent calls
 * @param {Function} fn - async (item, index) => result
 * @returns {Promise<Array>} Results in input order
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

module.exports = { mapLimit };
