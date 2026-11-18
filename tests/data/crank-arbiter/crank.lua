-- crank.lua -- the single writer for crank mode (a Redis Functions library, "crank").
--
-- Loaded by core/statekit.Library (bloodbank agent-hooks) with the statekit
-- prelude (`sk`) in front. Every proposer -- pj crank (pjangler, TypeScript,
-- through `redis-cli FCALL`), zcrankctl and the zcrank.py engine -- SENDS a
-- signal here and never writes a crank key itself. Redis runs one function at a
-- time, so a toggle racing a scan cannot lose an update and every edge carries
-- the value it provably replaced.
--
-- The registry (unchanged keys, so old readers keep working):
--   zcrank:tab:<key>            HASH   enabled 0|1, interval, root
--   zcrank:pane:<owner>:<pane>  STRING pane override 0|1
--   zcrank:log:<key>            LIST   {ts,state,action} rows, capped at 500
--   zcrank:config               HASH   interval (the global default)
-- The resolved state (new, written only here):
--   crank:p:<session>:<pane>    HASH   on, since, decided_by, interval, inherited,
--                                      tab, tab_key, keys, owners, last_run,
--                                      next_due, scan_ms, held, seq   (TTL 1d)
--   crank:idx:panes             SET    every crank:p key
--   crank:t:<session>:<pane>    STREAM that pane's transitions (MAXLEN ~500)
--   crank:t                     STREAM every transition (MAXLEN ~5000)
--   crank:transitions           PUBSUB one JSON message per transition
--   crank:engine                HASH   engine heartbeat: ts, scan_ms, panes, session (TTL 1d)
-- Crank v2 session bindings (crank:b:*, crank:idx:pane:*): see "Crank v2 bindings" below.
--
-- The rule (the ONLY copy; zcrank.py, zcrankctl and pjangler ask crank_resolve):
--   a pane override under ANY owner spelling decides (every one found must be 1);
--   else the tab: every governing key must have enabled=1 (any OFF wins);
--   no key at all = OFF ("unlisted"). Interval: the LONGEST set on any key, else
--   zcrank:config, else 5m.
-- Edges stamp `since`: an idempotent enable changes nothing, logs nothing and
-- keeps since. Continuity also breaks when the engine stopped (no scan for
-- GAP_MS): a pane that is ON is restarted at the next scan, cause "gap".

local LOG_CAP      = 500
local PANE_TTL_MS  = 86400000
local GAP_MS       = 900000      -- three missed */5 ticks
local HOLD         = 2           -- scans an unjudgeable pane keeps its state
local PANE_STREAM  = 500
local ALL_STREAM   = 5000
local INTERVALS    = { ['5m'] = 300, ['1h'] = 3600, ['6h'] = 21600, ['1d'] = 86400 }
local DEFAULT_INTERVAL = '5m'
local IDX          = 'crank:idx:panes'
local CHANNEL      = 'crank:transitions'
local ENGINE       = 'crank:engine'

local function interval_of(raw)
  if type(raw) == 'string' and INTERVALS[raw] then return raw end
  return nil
end

local function decode_list(raw)
  if type(raw) ~= 'string' or raw == '' then return {} end
  local ok, v = pcall(cjson.decode, raw)
  if not ok or type(v) ~= 'table' then return {} end
  local out = {}
  for _, x in ipairs(v) do
    if type(x) == 'string' and x ~= '' then out[#out + 1] = x end
  end
  return out
end

-- The rule. keys: governing zcrank:tab:<key> names; owners: every spelling a pane
-- override may sit under; pane: terminal_N (nil = tab level only).
local function resolve(keys, owners, pane)
  local r = { on = false, decided_by = 'unlisted' }
  local found = 0
  if pane and pane ~= '' then
    local all_on = true
    for _, o in ipairs(owners) do
      local v = redis.call('GET', 'zcrank:pane:' .. o .. ':' .. pane)
      if v and v ~= '' then
        found = found + 1
        if v ~= '1' then all_on = false end
      end
    end
    if found > 0 then
      r.on, r.decided_by = all_on, 'pane'
    end
  end
  if found == 0 and #keys > 0 then
    local all_on = true
    for _, k in ipairs(keys) do
      if redis.call('HGET', 'zcrank:tab:' .. k, 'enabled') ~= '1' then all_on = false end
    end
    r.on, r.decided_by = all_on, 'tab'
  end
  local best
  for _, k in ipairs(keys) do
    local i = interval_of(redis.call('HGET', 'zcrank:tab:' .. k, 'interval'))
    if i and (not best or INTERVALS[i] > INTERVALS[best]) then best = i end
  end
  if best then
    r.interval, r.inherited = best, false
  else
    r.interval = interval_of(redis.call('HGET', 'zcrank:config', 'interval')) or DEFAULT_INTERVAL
    r.inherited = true
  end
  return r
end

local function bool01(b) return b and '1' or '0' end

-- One transition: per-pane stream, the all-pane stream, and the channel.
local function transition(hkey, rec)
  local fields = {}
  for _, k in ipairs({ 'subject', 'session', 'pane', 'tab', 'field', 'from', 'to',
                       'since', 'cause', 'by', 'ts', 'seq' }) do
    if rec[k] ~= nil then
      fields[#fields + 1] = k
      fields[#fields + 1] = rec[k]
    end
  end
  local tkey = 'crank:t:' .. string.sub(hkey, #'crank:p:' + 1)
  sk.emit(tkey, PANE_STREAM, fields, nil, nil)
  sk.emit('crank:t', ALL_STREAM, fields, CHANNEL, cjson.encode(rec))
  return rec
end

-- Re-resolve one existing crank:p hash against the registry; emit edges.
local function reresolve(hkey, now, cause, by, edges)
  local cur = sk.hgetall(hkey)
  if not cur.pane then return end
  local r = resolve(decode_list(cur.keys), decode_list(cur.owners), cur.pane)
  local seq = tonumber(cur.seq) or 0
  local upd = {}
  local on = bool01(r.on)
  if cur.on ~= on then
    seq = seq + 1
    upd.on, upd.since = on, now
    edges[#edges + 1] = transition(hkey, { subject = hkey, session = cur.session, pane = cur.pane,
      tab = cur.tab, field = 'on', from = cur.on or '', to = on, since = now, cause = cause,
      by = by, ts = now, seq = seq })
  end
  if cur.interval ~= r.interval then
    seq = seq + 1
    upd.interval = r.interval
    edges[#edges + 1] = transition(hkey, { subject = hkey, session = cur.session, pane = cur.pane,
      tab = cur.tab, field = 'interval', from = cur.interval or '', to = r.interval,
      since = tonumber(upd.since or cur.since) or now, cause = cause, by = by, ts = now, seq = seq })
  end
  upd.decided_by, upd.inherited = r.decided_by, bool01(r.inherited)
  if seq ~= (tonumber(cur.seq) or 0) then upd.seq = seq end
  sk.hset(hkey, upd)
end

local function reresolve_all(now, cause, by, edges)
  for _, hkey in ipairs(redis.call('SMEMBERS', IDX)) do
    if redis.call('EXISTS', hkey) == 1 then
      reresolve(hkey, now, cause, by, edges)
    else
      redis.call('SREM', IDX, hkey)
    end
  end
end

local function log_row(key, ts, state, action)
  local lkey = 'zcrank:log:' .. key
  redis.call('RPUSH', lkey, cjson.encode({ ts = ts, state = state, action = action }))
  redis.call('LTRIM', lkey, -LOG_CAP, -1)
end

local function glob_escape(s)
  return (string.gsub(s, '[%*%?%[%]\\]', '\\%0'))
end

local function registry_key(k)
  return type(k) == 'string' and string.sub(k, 1, 7) == 'zcrank:' and not string.find(k, '[%*%?]')
end

-- FCALL crank_apply 0 <ops_json> <by>
-- ops: a JSON list of
--   {op="tab", key, enabled?=bool, interval?="5m"|..|"" (clear), root?=str,
--    root_if_absent?=str, action?=str, interval_action?=str, ts?=iso}
--       enabled/interval changes append the {ts,state,action} row pjangler and
--       zcrankctl used to write themselves -- ONLY when the value changed.
--   {op="pane", owner, pane, value="1"|"0"|"" (clear)}
--   {op="clear_panes", owner}            DEL every zcrank:pane:<owner>:* override
--   {op="config", interval}
--   {op="log", key, row}                 append a raw row (beat rows, renamed rows)
--   {op="replace_log", key, rows=[...]}  replace a whole log atomically
--   {op="del", key}                      DEL a zcrank:* registry key
-- Returns JSON {changed=<n>, results=[bool per op], edges=[...]}.
local function crank_apply(keys, args)
  local ops = cjson.decode(args[1] or '[]')
  local by = args[2] or ''
  local now = sk.now_ms()
  local iso_now = sk.iso(now)
  local results, changed = {}, 0
  for i, op in ipairs(ops) do
    local did = false
    local kind = op.op
    if kind == 'tab' then
      local hkey = 'zcrank:tab:' .. sk.str(op.key)
      local cur = sk.hgetall(hkey)
      local ts = sk.present(op.ts) and sk.str(op.ts) or iso_now
      if sk.present(op.interval) then
        local want = sk.str(op.interval)
        if want == '' then
          if cur.interval ~= nil then
            redis.call('HDEL', hkey, 'interval')
            log_row(op.key, ts, 'interval', sk.present(op.interval_action) and sk.str(op.interval_action) or 'interval default')
            did = true
          end
        elseif interval_of(want) and cur.interval ~= want then
          redis.call('HSET', hkey, 'interval', want)
          log_row(op.key, ts, 'interval', sk.present(op.interval_action) and sk.str(op.interval_action) or ('interval ' .. want))
          did = true
        end
      end
      if sk.present(op.enabled) then
        local want = (op.enabled == true or op.enabled == 1 or op.enabled == '1') and '1' or '0'
        if cur.enabled ~= want then
          redis.call('HSET', hkey, 'enabled', want)
          log_row(op.key, ts, want == '1' and 'enabled' or 'disabled',
            sk.present(op.action) and sk.str(op.action) or by)
          did = true
        end
      end
      if sk.present(op.root) and sk.str(op.root) ~= '' and cur.root ~= sk.str(op.root) then
        redis.call('HSET', hkey, 'root', sk.str(op.root))
        did = true
      elseif sk.present(op.root_if_absent) and sk.str(op.root_if_absent) ~= ''
          and (cur.root == nil or cur.root == '') then
        redis.call('HSET', hkey, 'root', sk.str(op.root_if_absent))
        did = true
      end
    elseif kind == 'pane' then
      local pkey = 'zcrank:pane:' .. sk.str(op.owner) .. ':' .. sk.str(op.pane)
      local want = sk.present(op.value) and sk.str(op.value) or ''
      local cur = redis.call('GET', pkey)
      if want == '' then
        did = redis.call('DEL', pkey) == 1
      elseif cur ~= want then
        redis.call('SET', pkey, want)
        did = true
      end
    elseif kind == 'clear_panes' then
      local prefix = 'zcrank:pane:' .. sk.str(op.owner) .. ':'
      for _, k in ipairs(redis.call('KEYS', glob_escape(prefix) .. '*')) do
        if not string.find(string.sub(k, #prefix + 1), ':', 1, true) then
          redis.call('DEL', k)
          did = true
        end
      end
    elseif kind == 'config' then
      local want = interval_of(sk.str(op.interval))
      if want and redis.call('HGET', 'zcrank:config', 'interval') ~= want then
        redis.call('HSET', 'zcrank:config', 'interval', want)
        did = true
      end
    elseif kind == 'log' then
      local lkey = 'zcrank:log:' .. sk.str(op.key)
      redis.call('RPUSH', lkey, sk.str(op.row))
      redis.call('LTRIM', lkey, -LOG_CAP, -1)
      did = true
    elseif kind == 'replace_log' then
      local lkey = 'zcrank:log:' .. sk.str(op.key)
      redis.call('DEL', lkey)
      local rows = type(op.rows) == 'table' and op.rows or {}
      for _, row in ipairs(rows) do redis.call('RPUSH', lkey, sk.str(row)) end
      if #rows > 0 then redis.call('LTRIM', lkey, -LOG_CAP, -1) end
      did = true
    elseif kind == 'del' then
      if registry_key(op.key) then did = redis.call('DEL', op.key) == 1 end
    else
      return redis.error_reply('crank_apply: unknown op ' .. sk.str(kind) .. ' at ' .. i)
    end
    results[i] = did
    if did then changed = changed + 1 end
  end
  local edges = {}
  if changed > 0 then reresolve_all(now, 'registry', by, edges) end
  return cjson.encode({ changed = changed, results = results, edges = edges })
end

-- FCALL_RO crank_resolve 0 <json {keys=[..], owners=[..], pane?}>
-- -> JSON {on, decided_by, interval, inherited}
local function crank_resolve(keys, args)
  local q = cjson.decode(args[1] or '{}')
  local function list(v)
    local out = {}
    if type(v) == 'table' then
      for _, x in ipairs(v) do if type(x) == 'string' and x ~= '' then out[#out + 1] = x end end
    end
    return out
  end
  local pane = sk.present(q.pane) and sk.str(q.pane) or nil
  local r = resolve(list(q.keys), list(q.owners), pane)
  return cjson.encode(r)
end

-- FCALL crank_scan 0 <json> <by>
-- json: {session, panes=[{pane, tab, tab_key, keys=[..], owners=[..], last_run_ms?,
--        next_due_ms?, seed_since_ms?}], unsure_tabs=[tab_key..], owners_unsure=bool}
-- The engine's observation of every live pane. Resolves each against the
-- registry (the rule above), stamps since on edges, holds what it cannot judge,
-- retires panes that closed, and beats the engine heartbeat.
-- Returns JSON {verdicts={pane={on, decided_by, interval, inherited}}, edges=[...], gap=bool}.
local function crank_scan(keys, args)
  local q = cjson.decode(args[1] or '{}')
  local by = args[2] or 'zcrank'
  local session = sk.str(q.session)
  local now = sk.now_ms()
  local prev_scan = tonumber(redis.call('HGET', ENGINE, 'scan_ms'))
  local gap = (prev_scan == nil) or now < prev_scan or (now - prev_scan) > GAP_MS
  local unsure = {}
  if type(q.unsure_tabs) == 'table' then
    for _, t in ipairs(q.unsure_tabs) do unsure[sk.str(t)] = true end
  end
  local owners_unsure = q.owners_unsure == true
  local edges, verdicts, seen = {}, {}, {}

  local function edge(hkey, cur, field, from, to, since, cause, seq)
    edges[#edges + 1] = transition(hkey, { subject = hkey, session = session, pane = cur.pane,
      tab = cur.tab, field = field, from = from, to = to, since = since, cause = cause,
      by = by, ts = now, seq = seq })
  end

  for _, p in ipairs(type(q.panes) == 'table' and q.panes or {}) do
    local pane = sk.str(p.pane)
    if pane ~= '' then
      local hkey = 'crank:p:' .. session .. ':' .. pane
      seen[hkey] = true
      local kl = decode_list(cjson.encode(type(p.keys) == 'table' and p.keys or {}))
      local ol = decode_list(cjson.encode(type(p.owners) == 'table' and p.owners or {}))
      local r = resolve(kl, ol, pane)
      local cur = sk.hgetall(hkey)
      local tab_key = sk.str(p.tab_key)
      local same = cur.pane ~= nil and cur.tab_key == tab_key
      local seq = tonumber(cur.seq) or 0
      local on = bool01(r.on)
      local held = 0
      local since = tonumber(cur.since)
      local info = { pane = pane, tab = sk.str(p.tab), tab_key = tab_key,
                     keys = sk.json_list(kl), owners = sk.json_list(ol) }
      if same and owners_unsure and not r.on and cur.on == '1'
          and (tonumber(cur.held) or 0) < HOLD and not gap then
        -- The owner lookup failed: an OFF read only for want of it is held, not believed.
        on, held = '1', (tonumber(cur.held) or 0) + 1
      elseif not same then
        local seed = tonumber(p.seed_since_ms)
        since = (r.on and seed and seed > 0 and seed <= now) and seed or now
        seq = seq + 1
        info.session = session
        sk.hset(hkey, info)
        edge(hkey, info, 'on', cur.on or '', on, since, cur.pane and 'retab' or 'appear', seq)
      elseif cur.on ~= on then
        since, seq = now, seq + 1
        edge(hkey, cur, 'on', cur.on or '', on, since, 'scan', seq)
      elseif gap and on == '1' then
        -- The engine stopped: nothing before this scan was continuous.
        since, seq = now, seq + 1
        edge(hkey, cur, 'on', on, on, since, 'gap', seq)
      end
      if same and cur.interval ~= r.interval and cur.interval ~= nil then
        seq = seq + 1
        edge(hkey, cur, 'interval', cur.interval, r.interval, since or now, 'scan', seq)
      end
      info.session = session
      info.on, info.since, info.seq, info.held = on, since or now, seq, held
      info.decided_by, info.interval, info.inherited = r.decided_by, r.interval, bool01(r.inherited)
      info.last_run = sk.present(p.last_run_ms) and sk.str(p.last_run_ms) or ''
      info.next_due = sk.present(p.next_due_ms) and sk.str(p.next_due_ms) or ''
      info.scan_ms = now
      sk.hset(hkey, info)
      redis.call('PEXPIRE', hkey, PANE_TTL_MS)
      redis.call('SADD', IDX, hkey)
      verdicts[pane] = { on = r.on, decided_by = r.decided_by, interval = r.interval,
                         inherited = r.inherited }
    end
  end

  -- Panes of this session the scan did not see: closed, unless their tab could not be read.
  for _, hkey in ipairs(redis.call('SMEMBERS', IDX)) do
    if not seen[hkey] then
      local cur = sk.hgetall(hkey)
      if cur.pane == nil then
        redis.call('SREM', IDX, hkey)
      elseif cur.session == session then
        local held = tonumber(cur.held) or 0
        if unsure[cur.tab_key or ''] and held < HOLD and not gap then
          redis.call('HSET', hkey, 'held', held + 1)
        else
          local seq = (tonumber(cur.seq) or 0) + 1
          edge(hkey, cur, 'on', cur.on or '', 'closed', now, unsure[cur.tab_key or ''] and 'unreadable' or 'closed', seq)
          redis.call('DEL', hkey)
          redis.call('SREM', IDX, hkey)
        end
      end
    end
  end

  sk.heartbeat(ENGINE, PANE_TTL_MS, { scan_ms = now, session = session, by = by,
    panes = #(type(q.panes) == 'table' and q.panes or {}) })
  return cjson.encode({ verdicts = verdicts, edges = edges, gap = gap })
end

-- ---------------------------------------------------------------------------
-- Crank v2 bindings (pjangler PJAN-214/215): one crank per live agent SESSION.
-- The Candybar row is the registry and the clock; this is its live projection,
-- what a prompt or a dashboard reads without asking Candybar.
--   crank:b:<binding>               HASH   binding, cli, session_id, pid, pid_start,
--                                          project, root, zellij_session, pane (terminal_N),
--                                          interval, schedule, candybar_id, on=1,
--                                          since (attach ms), last_fire (ms), fires,
--                                          last_class, last_officer, last_officer_ms,
--                                          next_due (ms), reclocked_ms, seq, updated_ms
--                                          (TTL three intervals, at least 1h; every
--                                          attach and fire refreshes it)
--   crank:idx:pane:<session>:<pane> STRING the binding bound in that pane (TWICE the hash
--                                          TTL: a pointer whose hash expired reads as a
--                                          crank that stopped firing, never as "off")
--   crank:idx:bindings              SET    every crank:b key (attach prunes expired ones)
--   crank:t:b:<binding>             STREAM that binding's transitions (MAXLEN ~500,
--                                          expires with the binding)
--   crank:b:<binding>:ended         STRING tombstone: the end reason (TTL 3d, the longest
--                                          a hash can live). An ended binding never comes back:
--                                          a fire that finishes after its end is refused.
-- Transitions also go to crank:t and crank:transitions, subject crank:b:<binding>.
-- Kept apart from crank:p / crank:idx:panes on purpose: crank_scan rewrites every
-- pane hash it sees and deletes the indexed ones it does not, so a v2 pane must
-- never live under the legacy keys.
do
  local B_IDX = 'crank:idx:bindings'
  local B_MIN_TTL_MS = 3600000
  local B_TOMB_TTL_MS = 3 * 86400000
  local B_FIELDS = { 'cli', 'session_id', 'pid', 'pid_start', 'project', 'root',
                     'zellij_session', 'pane', 'interval', 'schedule', 'candybar_id',
                     'next_due', 'last_class', 'last_officer', 'last_officer_ms' }
  local B_EDGE_FIELDS = { 'subject', 'binding', 'session', 'pane', 'field', 'from', 'to',
                          'since', 'cause', 'detail', 'by', 'ts', 'seq' }

  local function b_name(v)
    local name = sk.str(v)
    if string.match(name, '^crank%-[%w%-]+$') then return name end
    return nil
  end

  local function b_pane(v)
    local p = sk.str(v)
    if string.match(p, '^%d+$') then return 'terminal_' .. p end
    if string.match(p, '^terminal_%d+$') then return p end
    return nil
  end

  -- v2 intervals are pjangler's grammar (policy.ts normaliseInterval): 1-59m, 1-23h, 1d.
  local function b_interval_s(v)
    local n, unit = string.match(sk.str(v), '^(%d+)([mhd])$')
    n = tonumber(n)
    if not n then return nil end
    if unit == 'm' and n >= 1 and n <= 59 then return n * 60 end
    if unit == 'h' and n >= 1 and n <= 23 then return n * 3600 end
    if unit == 'd' and n == 1 then return 86400 end
    return nil
  end

  local function b_ttl(interval)
    local s = b_interval_s(interval) or INTERVALS[DEFAULT_INTERVAL]
    return math.max(B_MIN_TTL_MS, s * 3000)
  end

  -- One transition: the binding's own stream (expiring with it), crank:t and the channel.
  local function b_edge(name, where, field, from, to, since, cause, by, now, seq, ttl, detail)
    local rec = { subject = 'crank:b:' .. name, binding = name, session = where.zellij_session,
                  pane = where.pane, field = field, from = from, to = to, since = since,
                  cause = cause, by = by, ts = now, seq = seq }
    if detail and detail ~= '' then rec.detail = string.sub(detail, 1, 300) end
    local fields = {}
    for _, k in ipairs(B_EDGE_FIELDS) do
      if rec[k] ~= nil then
        fields[#fields + 1] = k
        fields[#fields + 1] = rec[k]
      end
    end
    local tkey = 'crank:t:b:' .. name
    sk.emit(tkey, PANE_STREAM, fields, nil, nil)
    redis.call('PEXPIRE', tkey, ttl)
    sk.emit('crank:t', ALL_STREAM, fields, CHANNEL, cjson.encode(rec))
    return rec
  end

  local function b_pointer(session, pane)
    return 'crank:idx:pane:' .. session .. ':' .. pane
  end

  local function b_tomb(name)
    return 'crank:b:' .. name .. ':ended'
  end

  -- attach and fire share one upsert: a fire whose hash expired (Redis restarted,
  -- a 1d crank outlived its TTL) re-creates it from the facts the fire carries.
  -- An ENDED binding (tombstone) is refused: its last fire may finish after its end.
  local function b_upsert(q, by, cause)
    local name = b_name(q.binding)
    if not name then return cjson.encode({ error = 'binding must be crank-<cli>-<sid8>-<pid>' }) end
    local ended = redis.call('GET', b_tomb(name))
    if ended then
      return cjson.encode({ binding = name, refused = 'ended', reason = ended, created = false })
    end
    local bkey = 'crank:b:' .. name
    local now = sk.now_ms()
    local cur = sk.hgetall(bkey)
    local info = {}
    for _, k in ipairs(B_FIELDS) do
      if sk.present(q[k]) and sk.str(q[k]) ~= '' then info[k] = sk.str(q[k]) end
    end
    if info.pane then info.pane = b_pane(info.pane) end
    if info.interval and not b_interval_s(info.interval) then info.interval = nil end
    local session = info.zellij_session or cur.zellij_session
    local pane = info.pane or cur.pane
    local interval = info.interval or cur.interval
    local ttl = b_ttl(interval)
    local seq = tonumber(cur.seq) or 0
    local edges = {}
    local where = { zellij_session = session, pane = pane }
    local created = cur.binding == nil
    if created then
      seq = seq + 1
      info.on, info.since = '1', now
      edges[#edges + 1] = b_edge(name, where, 'on', '', '1', now,
        cause == 'fire' and 'reappear' or 'attach', by, now, seq, ttl)
    else
      if info.interval and cur.interval and info.interval ~= cur.interval then
        seq = seq + 1
        info.reclocked_ms = now
        edges[#edges + 1] = b_edge(name, where, 'interval', cur.interval, info.interval,
          tonumber(cur.since) or now, cause, by, now, seq, ttl)
      end
      if info.pane and cur.pane and info.pane ~= cur.pane then
        seq = seq + 1
        edges[#edges + 1] = b_edge(name, where, 'pane', cur.pane, info.pane,
          tonumber(cur.since) or now, cause, by, now, seq, ttl)
        local old = b_pointer(cur.zellij_session or session or '', cur.pane)
        if redis.call('GET', old) == name then redis.call('DEL', old) end
      end
    end
    if cause == 'fire' then
      info.last_fire = now
      info.fires = (tonumber(cur.fires) or 0) + 1
    end
    info.binding, info.seq, info.updated_ms = name, seq, now
    sk.hset(bkey, info)
    redis.call('PEXPIRE', bkey, ttl)
    redis.call('PEXPIRE', 'crank:t:b:' .. name, ttl)
    redis.call('SADD', B_IDX, bkey)
    if session and session ~= '' and pane then
      local ptr = b_pointer(session, pane)
      local holder = redis.call('GET', ptr)
      -- attach claims the pane; a fire only keeps its own claim (never takes a successor's)
      if cause == 'attach' or not holder or holder == name then
        redis.call('SET', ptr, name, 'PX', 2 * ttl)
      end
    end
    if cause == 'attach' then
      for _, k in ipairs(redis.call('SMEMBERS', B_IDX)) do
        if redis.call('EXISTS', k) == 0 then redis.call('SREM', B_IDX, k) end
      end
    end
    return cjson.encode({ binding = name, created = created, seq = seq, ttl_ms = ttl, edges = edges })
  end

  -- FCALL crank_attach 0 <json> <by>
  -- json: {binding, cli, session_id, pid, pid_start, project, root, zellij_session,
  --        pane, interval, schedule, candybar_id, next_due?}
  -- Idempotent: a repeat keeps `since` and emits only real changes (interval, pane).
  -- Returns JSON {binding, created, seq, ttl_ms, edges} or {binding, refused="ended", reason}.
  local function crank_attach(keys, args)
    return b_upsert(cjson.decode(args[1] or '{}'), args[2] or 'pj', 'attach')
  end

  -- FCALL crank_fire 0 <json> <by>
  -- json: the attach facts plus {last_class, last_officer?, last_officer_ms?, next_due}.
  -- Stamps last_fire, counts fires, refreshes the TTL.
  local function crank_fire(keys, args)
    return b_upsert(cjson.decode(args[1] or '{}'), args[2] or 'pj', 'fire')
  end

  -- FCALL crank_end 0 <json> <by>
  -- json: {binding, reason, detail?, zellij_session?, pane?} (the pane facts drop the
  -- pointer even when the hash already expired). Emits on: <was> -> ended, cause
  -- = the reason (explicit|session_end|superseded|disabled|pane_closed|orphan_reaped),
  -- and leaves the tombstone. Returns JSON {binding, ended, edges}.
  local function crank_end(keys, args)
    local q = cjson.decode(args[1] or '{}')
    local by = args[2] or 'pj'
    local name = b_name(q.binding)
    if not name then return cjson.encode({ error = 'binding must be crank-<cli>-<sid8>-<pid>' }) end
    local bkey = 'crank:b:' .. name
    local now = sk.now_ms()
    local cur = sk.hgetall(bkey)
    local session = cur.zellij_session or (sk.present(q.zellij_session) and sk.str(q.zellij_session)) or ''
    local pane = cur.pane or b_pane(q.pane)
    local edges = {}
    local reason = sk.str(q.reason)
    if reason == '' then reason = 'ended' end
    if cur.binding ~= nil then
      edges[1] = b_edge(name, { zellij_session = session, pane = pane }, 'on', cur.on or '1', 'ended',
        now, reason, by, now, (tonumber(cur.seq) or 0) + 1, B_TOMB_TTL_MS, sk.str(q.detail))
    end
    if session ~= '' and pane then
      local ptr = b_pointer(session, pane)
      if redis.call('GET', ptr) == name then redis.call('DEL', ptr) end
    end
    redis.call('SET', b_tomb(name), reason, 'PX', B_TOMB_TTL_MS)
    redis.call('DEL', bkey)
    redis.call('SREM', B_IDX, bkey)
    return cjson.encode({ binding = name, ended = cur.binding ~= nil, edges = edges })
  end

  -- FCALL_RO crank_get 0 <session> <pane>
  -- The binding bound in that zellij pane, as a flat HGETALL reply. Empty when none is,
  -- or when the pointer outlived a hash that now names another pane. A pointer whose hash
  -- EXPIRED (no fire refreshed it for three intervals, and it was never ended) answers
  -- {binding, pane, expired=1}: a crank that stopped firing, which a reader shows as stalled.
  -- pane: N or terminal_N. One round trip: the prompt pipelines this with its other reads.
  local function crank_get(keys, args)
    local session, pane = sk.str(args[1]), b_pane(args[2])
    if session == '' or not pane then return {} end
    local name = redis.call('GET', b_pointer(session, pane))
    if not name then return {} end
    local flat = redis.call('HGETALL', 'crank:b:' .. name)
    if #flat == 0 then
      if redis.call('EXISTS', b_tomb(name)) == 1 then return {} end
      return { 'binding', name, 'pane', pane, 'expired', '1' }
    end
    for i = 1, #flat, 2 do
      if flat[i] == 'pane' then
        if flat[i + 1] == pane then return flat end
        return {}
      end
    end
    return {}
  end

  redis.register_function('crank_attach', crank_attach)
  redis.register_function('crank_fire', crank_fire)
  redis.register_function('crank_end', crank_end)
  redis.register_function{ function_name = 'crank_get', callback = crank_get,
                           flags = { 'no-writes' } }
end

redis.register_function('crank_apply', crank_apply)
redis.register_function('crank_scan', crank_scan)
redis.register_function{ function_name = 'crank_resolve', callback = crank_resolve,
                         flags = { 'no-writes' } }
