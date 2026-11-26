const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { ApiError, canonical } = require('./config.cjs');

const dayMs = 24 * 60 * 60 * 1000;

function findRule(data, namespace, id) {
  const entry = Object.hasOwn(data.rules, id) ? data.rules[id] : undefined;
  if (!entry || entry.rule.namespace !== namespace || entry.rule.state === 'deleted') {
    throw new ApiError(404, 'RULE_NOT_FOUND', '规则不存在');
  }
  return entry;
}

function findVersion(entry, number) {
  const version = entry.versions[number - 1];
  if (!version || version.version !== number) {
    throw new ApiError(404, 'VERSION_NOT_FOUND', '版本不存在');
  }
  return version;
}

function audit(entry, action, subject, at) {
  const { revision, latestVersion, activeVersion, state } = entry.rule;
  entry.audit.push({ revision, latestVersion, activeVersion, state, action, subject, at });
}

function openStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS mock_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
    INSERT OR IGNORE INTO mock_state VALUES (1, '{"rules":{},"replays":{}}');
  `);
  const select = db.prepare('SELECT data FROM mock_state WHERE id = 1');
  const save = db.prepare('UPDATE mock_state SET data = ? WHERE id = 1');
  const read = () => JSON.parse(select.get().data);

  // 同一事务保存规则、不可变版本、修订历史和幂等结果。
  function write(change) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const data = read();
      const result = change(data);
      save.run(JSON.stringify(data));
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    close: () => db.close(),

    list(namespace, { name, state }) {
      return Object.values(read().rules)
        .map(({ rule }) => rule)
        .filter((rule) => rule.namespace === namespace && rule.state !== 'deleted' &&
          (name === undefined || rule.name === name) && (state === undefined || rule.state === state))
        .sort((left, right) => left.id.localeCompare(right.id));
    },

    get(namespace, id) {
      return findRule(read(), namespace, id);
    },

    active(namespace) {
      return Object.values(read().rules).filter(({ rule }) => (
        rule.namespace === namespace && rule.state === 'enabled'
      ));
    },

    create(namespace, subject, key, input, config) {
      return write((data) => {
        const now = Date.now();
        for (const [storedKey, replay] of Object.entries(data.replays)) {
          if (replay.expiresAt <= now) delete data.replays[storedKey];
        }
        const replayKey = JSON.stringify([subject, namespace, key]);
        const fingerprint = canonical(input);
        const replay = data.replays[replayKey];
        if (replay) {
          if (replay.fingerprint !== fingerprint) {
            throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', '此幂等键已用于其他请求');
          }
          return { rule: replay.rule, changed: false };
        }
        let { id } = input;
        if (id === undefined) {
          do {
            id = randomUUID();
          } while (Object.hasOwn(data.rules, id));
        } else if (Object.hasOwn(data.rules, id)) {
          throw new ApiError(409, 'DUPLICATE_RULE_ID', '规则 ID 已存在');
        }
        const at = new Date(now).toISOString();
        const rule = {
          id, namespace, name: input.name, description: config.description,
          state: 'disabled', activeVersion: null, latestVersion: 1, revision: 1,
          createdAt: at, updatedAt: at,
        };
        const entry = {
          rule, versions: [{ ruleId: id, version: 1, createdAt: at, ...config }], audit: [],
        };
        audit(entry, 'create', subject, at);
        Object.defineProperty(data.rules, id, { value: entry, enumerable: true });
        data.replays[replayKey] = { expiresAt: now + dayMs, fingerprint, rule };
        return { rule, changed: true };
      });
    },

    change(namespace, id, subject, ifMatch, action, apply) {
      return write((data) => {
        const entry = findRule(data, namespace, id);
        const { rule } = entry;
        if (ifMatch === undefined) {
          throw new ApiError(428, 'PRECONDITION_REQUIRED', '需要 If-Match');
        }
        if (ifMatch !== etag(rule)) {
          throw new ApiError(412, 'REVISION_MISMATCH', '规则修订号已变更');
        }
        const at = new Date().toISOString();
        const changed = apply(entry, data, at);
        if (changed) {
          rule.revision += 1;
          rule.updatedAt = at;
          audit(entry, action, subject, at);
        }
        return { rule, changed };
      });
    },
  };
}

function etag(rule) {
  return `"${rule.revision}"`;
}

function activate(entry, data, state, number) {
  const { rule } = entry;
  if (rule.state === state && rule.activeVersion === number) return false;
  if (state === 'enabled') {
    const version = findVersion(entry, number);
    for (const other of Object.values(data.rules)) {
      const candidate = other.rule;
      if (candidate.id === rule.id || candidate.namespace !== rule.namespace || candidate.state !== 'enabled') continue;
      const active = findVersion(other, candidate.activeVersion);
      if (active.priority === version.priority && active.match.method === version.match.method &&
          active.match.path === version.match.path) {
        throw new ApiError(409, 'RULE_CONFLICT', '该匹配优先级已被启用规则占用', {
          conflictingRuleId: candidate.id,
        });
      }
    }
  }
  rule.state = state;
  rule.activeVersion = number;
  return true;
}

module.exports = { activate, etag, findVersion, openStore };
