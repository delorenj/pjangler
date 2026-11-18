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

-- Registry reads never abort the caller: a key of the wrong type (an error reply) reads as ABSENT,
-- so one malformed key fails closed for that key alone instead of failing every pane of the scan.
local function rget(key)
  local v = redis.pcall('GET', key)
  if type(v) ~= 'string' then return nil end
  return v
end

local function rhget(key, field)
  local v = redis.pcall('HGET', key, field)
  if type(v) ~= 'string' then return nil end
  return v
end

-- The rule. keys: governing zcrank:tab:<key> names; owners: every spelling a pane
-- override may sit under; pane: terminal_N (nil = tab level only).
local function resolve(keys, owners, pane)
  local r = { on = false, decided_by = 'unlisted' }
  local found = 0
  if pane and pane ~= '' then
    local all_on = true
    for _, o in ipairs(owners) do
      local v = rget('zcrank:pane:' .. o .. ':' .. pane)
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
      if rhget('zcrank:tab:' .. k, 'enabled') ~= '1' then all_on = false end
    end
    r.on, r.decided_by = all_on, 'tab'
  end
  local best
  for _, k in ipairs(keys) do
    local i = interval_of(rhget('zcrank:tab:' .. k, 'interval'))
    if i and (not best or INTERVALS[i] > INTERVALS[best]) then best = i end
  end
  if best then
    r.interval, r.inherited = best, false
  else
    r.interval = interval_of(rhget('zcrank:config', 'interval')) or DEFAULT_INTERVAL
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

-- zcrank.py _norm for ASCII: lowercase, alphanumerics only (the engine's tab_key). Redis Lua runs
-- in the C locale, so a non-ASCII letter is dropped here and kept there: such a tab just waits
-- for the engine's next scan, as every tab did before.
local function canon(s)
  return (string.gsub(string.lower(s), '[^%w]', ''))
end

-- A tab op on key K: every pane whose tab is named K (tab_key == canon(K)) is governed by K from
-- now on, exactly as the engine's next scan will find it (tab_keys_for). Adopting K here lets the
-- re-resolve that follows show a never-seen tab ON at once, not five minutes later.
local function adopt_key(key)
  local c = canon(key)
  if c == '' then return end
  for _, hkey in ipairs(redis.call('SMEMBERS', IDX)) do
    local v = redis.call('HMGET', hkey, 'pane', 'tab_key', 'keys', 'owners')
    if v[1] and v[2] == c then
      local kl = decode_list(v[3])
      local has = false
      for _, k in ipairs(kl) do if k == key then has = true end end
      if not has then
        kl[#kl + 1] = key
        -- owners as the engine sends them (pane_owners): the keys first, then the tab's own name
        local ol, seen = {}, {}
        for _, o in ipairs(kl) do
          if not seen[o] then ol[#ol + 1], seen[o] = o, true end
        end
        for _, o in ipairs(decode_list(v[4])) do
          if not seen[o] then ol[#ol + 1], seen[o] = o, true end
        end
        redis.call('HSET', hkey, 'keys', sk.json_list(kl), 'owners', sk.json_list(ol))
      end
    end
  end
end

-- What zcrank.py last_run() counts as a run (keep the two in step): a JSON object whose `state` is
-- not one pjangler writes and whose `ts` parses as LOG_TS, datetime.strptime('%Y-%m-%dT%H:%M:%SZ'):
-- a 4-digit year, 1-2 digit fields (strptime's %d also takes ' 8'), a real calendar date, sec <= 59.
local PJ_LOG_STATES = { enabled = true, disabled = true, interval = true, renamed = true }
local CRON_S, GRACE_S = 300, 300           -- zcrank.py CRON / GRACE

local function days_in_month(y, m)
  if m == 2 then
    return ((y % 4 == 0 and y % 100 ~= 0) or y % 400 == 0) and 29 or 28
  end
  if m == 4 or m == 6 or m == 9 or m == 11 then return 30 end
  return 31
end

local function log_ts_ms(ts)
  if type(ts) ~= 'string' then return nil end
  local Y, mo, d, H, Mi, S = string.match(ts,
    '^(%d%d%d%d)%-(%d%d?)%-([ %d]?%d)T(%d%d?):(%d%d?):(%d%d?)Z$')
  if not Y then return nil end
  Y, mo, d, H, Mi, S = tonumber(Y), tonumber(mo), tonumber(d), tonumber(H), tonumber(Mi), tonumber(S)
  if not d or Y < 1 or mo < 1 or mo > 12 or d < 1 or d > days_in_month(Y, mo)
      or H > 23 or Mi > 59 or S > 59 then
    return nil
  end
  local y = mo <= 2 and Y - 1 or Y                    -- days from civil (Hinnant)
  local era = math.floor(y / 400)
  local yoe = y - era * 400
  local doy = math.floor((153 * ((mo + 9) % 12) + 2) / 5) + d - 1
  local days = era * 146097 + yoe * 365 + math.floor(yoe / 4) - math.floor(yoe / 100) + doy - 719468
  return ((days * 86400) + H * 3600 + Mi * 60 + S) * 1000
end

local function beat_ms(raw)
  local ok, d = pcall(cjson.decode, raw)
  if not ok or type(d) ~= 'table' then return nil end
  if type(d.state) == 'string' and PJ_LOG_STATES[d.state] then return nil end
  return log_ts_ms(d.ts)
end

-- A beat row for key K moves last_run on every pane K governs, as the engine's next scan would
-- (the newest run across every key's log; only tabs slower than the 5m tick track it at all), and
-- next_due with it (zcrank.py schedule()): the prompt's countdown is right right after the beat.
local function stamp_last_run(key, ran, now)
  for _, hkey in ipairs(redis.call('SMEMBERS', IDX)) do
    local v = redis.call('HMGET', hkey, 'pane', 'keys', 'last_run', 'interval')
    local secs = INTERVALS[v[4] or '']
    if v[1] and secs and secs > CRON_S and ran > (tonumber(v[3]) or 0) then
      local governs = false
      for _, k in ipairs(decode_list(v[2])) do if k == key then governs = true end end
      if governs then
        local ready = ran + (secs - GRACE_S) * 1000
        local due = ''
        if now < ready then due = math.ceil(ready / (CRON_S * 1000)) * CRON_S * 1000 end
        sk.hset(hkey, { last_run = ran, next_due = due })
      end
    end
  end
end

-- The fields each op needs as non-empty strings. Checked for EVERY op before the first write: a
-- bad op used to write 'zcrank:tab:' (an empty key) or half a batch before failing.
local OP_NEEDS = {
  tab = { 'key' }, pane = { 'owner', 'pane' }, clear_panes = { 'owner' }, config = {},
  log = { 'key', 'row' }, replace_log = { 'key' }, del = { 'key' },
}

-- FCALL crank_apply 0 <ops_json> <by>
-- ops: a JSON list of
--   {op="tab", key, enabled?=bool, interval?="5m"|..|"" (clear), root?=str,
--    root_if_absent?=str, action?=str, interval_action?=str, ts?=iso}
--       enabled/interval changes append the {ts,state,action} row pjangler and
--       zcrankctl used to write themselves -- ONLY when the value changed.
--       A change also adopts K into the governing keys of the panes whose tab K names.
--   {op="pane", owner, pane, value="1"|"0"|"" (clear)}
--   {op="clear_panes", owner}            DEL every zcrank:pane:<owner>:* override
--   {op="config", interval}
--   {op="log", key, row}                 append a raw row (beat rows, renamed rows); a beat
--                                        row also stamps last_run on the panes key governs
--   {op="replace_log", key, rows=[...]}  replace a whole log atomically
--   {op="del", key}                      DEL a zcrank:* registry key
-- Every op is validated before anything is written (error reply, nothing written).
-- Returns JSON {changed=<n>, results=[bool per op], edges=[...]}. Only ops that can move the
-- rule re-resolve the panes: a log row never does.
local function crank_apply(keys, args)
  local ops = cjson.decode(args[1] or '[]')
  if type(ops) ~= 'table' then return redis.error_reply('crank_apply: ops must be a JSON list') end
  for i, op in ipairs(ops) do
    if type(op) ~= 'table' then
      return redis.error_reply('crank_apply: op ' .. i .. ' is not an object')
    end
    local need = OP_NEEDS[op.op]
    if not need then
      return redis.error_reply('crank_apply: unknown op ' .. sk.str(op.op) .. ' at ' .. i)
    end
    for _, f in ipairs(need) do
      if type(op[f]) ~= 'string' or op[f] == '' then
        return redis.error_reply('crank_apply: op ' .. i .. ' (' .. op.op .. '): ' .. f
          .. ' must be a non-empty string')
      end
    end
  end
  local by = args[2] or ''
  local now = sk.now_ms()
  local iso_now = sk.iso(now)
  local results, changed, rule_changed = {}, 0, 0
  for i, op in ipairs(ops) do
    local did = false
    local kind = op.op
    local moves_rule = true
    if kind == 'tab' then
      local hkey = 'zcrank:tab:' .. op.key
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
      if did then adopt_key(op.key) end
    elseif kind == 'pane' then
      local pkey = 'zcrank:pane:' .. op.owner .. ':' .. op.pane
      local want = sk.present(op.value) and sk.str(op.value) or ''
      local cur = redis.call('GET', pkey)
      if want == '' then
        did = redis.call('DEL', pkey) == 1
      elseif cur ~= want then
        redis.call('SET', pkey, want)
        did = true
      end
    elseif kind == 'clear_panes' then
      local prefix = 'zcrank:pane:' .. op.owner .. ':'
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
      local lkey = 'zcrank:log:' .. op.key
      redis.call('RPUSH', lkey, op.row)
      redis.call('LTRIM', lkey, -LOG_CAP, -1)
      did, moves_rule = true, false
      local ran = beat_ms(op.row)
      if ran then stamp_last_run(op.key, ran, now) end
    elseif kind == 'replace_log' then
      local lkey = 'zcrank:log:' .. op.key
      redis.call('DEL', lkey)
      local rows = type(op.rows) == 'table' and op.rows or {}
      for _, row in ipairs(rows) do redis.call('RPUSH', lkey, sk.str(row)) end
      if #rows > 0 then redis.call('LTRIM', lkey, -LOG_CAP, -1) end
      did, moves_rule = true, false
    elseif kind == 'del' then
      if registry_key(op.key) then did = redis.call('DEL', op.key) == 1 end
      moves_rule = string.sub(op.key, 1, 11) ~= 'zcrank:log:'
    end
    results[i] = did
    if did then
      changed = changed + 1
      if moves_rule then rule_changed = rule_changed + 1 end
    end
  end
  local edges = {}
  if rule_changed > 0 then reresolve_all(now, 'registry', by, edges) end
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
      local holding = false
      if same and owners_unsure and not r.on and cur.on == '1'
          and (tonumber(cur.held) or 0) < HOLD and not gap then
        -- The owner lookup failed: an OFF read only for want of it is held, not believed. The
        -- hold keeps the last GOOD resolution whole (its governing lists, decided_by, interval):
        -- storing the empty lists made the next registry re-resolve read the pane unlisted OFF.
        on, held, holding = '1', (tonumber(cur.held) or 0) + 1, true
        info.keys, info.owners = cur.keys or '[]', cur.owners or '[]'
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
      if same and not holding and cur.interval ~= r.interval and cur.interval ~= nil then
        seq = seq + 1
        edge(hkey, cur, 'interval', cur.interval, r.interval, since or now, 'scan', seq)
      end
      info.session = session
      info.on, info.since, info.seq, info.held = on, since or now, seq, held
      if holding then
        info.decided_by, info.interval, info.inherited = cur.decided_by, cur.interval, cur.inherited
      else
        info.decided_by, info.interval, info.inherited = r.decided_by, r.interval, bool01(r.inherited)
      end
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
