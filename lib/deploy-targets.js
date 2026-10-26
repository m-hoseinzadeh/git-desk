const fs = require('fs');
const path = require('path');

// Holds webhook tokens, so it is gitignored and readable only by the user
const FILE = path.join(__dirname, '..', 'deploy-targets.json');

let targets = null; // commonDir -> { url }

function load() {
  if (targets) return targets;
  try {
    targets = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Could not read ${FILE}: ${error.message}`);
    targets = {};
  }
  return targets;
}

async function save() {
  const tmp = `${FILE}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(targets, null, 2)}\n`, { mode: 0o600 });
  await fs.promises.rename(tmp, FILE);
}

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

/**
 * Check a ci-agent webhook URL and return its zip form. A pasted /git hook URL becomes
 * the /zip one of the same project.
 * @param {string} url - https://ci.example/hooks/<slug>/<token>/zip
 * @returns {string} The zip webhook URL
 */
function parseHookUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url).trim());
  } catch {
    throw invalid('Enter the ci-agent zip webhook URL (https://…/hooks/<project>/<token>/zip)');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw invalid('The webhook URL must start with http:// or https://');
  }
  const match = parsed.pathname.match(/^(.*\/hooks\/[^/]+\/[^/]+\/)(zip|git)\/?$/);
  if (!match) {
    throw invalid('Not a ci-agent webhook URL: it should end in /hooks/<project>/<token>/zip');
  }
  parsed.pathname = `${match[1]}zip`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

/**
 * What the UI may show of a target: everything but the token
 */
function masked(url) {
  const parsed = new URL(url);
  const [, prefix, slug] = parsed.pathname.match(/^(.*\/hooks\/)([^/]+)\//);
  return {
    host: parsed.host,
    slug: decodeURIComponent(slug),
    display: `${parsed.origin}${prefix}${slug}/…/zip`
  };
}

function get(commonDir) {
  return load()[commonDir]?.url || null;
}

async function set(commonDir, url) {
  load()[commonDir] = { url: parseHookUrl(url) };
  await save();
}

async function remove(commonDir) {
  if (!(commonDir in load())) return;
  delete targets[commonDir];
  await save();
}

module.exports = { parseHookUrl, masked, get, set, remove };
