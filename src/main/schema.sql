-- Lagoon local app store (node:sqlite, userData/app.db). Single local user.
-- ids are text uuids (crypto.randomUUID), times are ISO-8601 UTC text.
pragma foreign_keys = on;
pragma journal_mode = wal;

create table if not exists tags (
  id text primary key,
  name text not null unique,
  color text not null,
  builtin integer not null default 0
);

create table if not exists groups (
  id text primary key,
  name text not null,
  icon text,
  parent_id text references groups(id) on delete cascade,   -- deleting a group deletes its contents
  sort_order integer not null default 0
);
create index if not exists groups_parent on groups(parent_id);

create table if not exists connections (
  id text primary key,
  name text not null,
  driver text not null check (driver in ('postgres','mysql','mariadb','sqlite','redis','mongodb')),
  host text, port integer, username text, database text, file_path text,
  password_mode text not null default 'store' check (password_mode in ('store','ask','none','command')),
  password_command text,
  secret blob,                       -- safeStorage-encrypted json {password, sshPassword, passphrase}
  status_color text,
  tag_id text references tags(id) on delete set null,
  group_id text references groups(id) on delete cascade,
  safe_mode integer not null default 0 check (safe_mode between 0 and 4), -- silent, alert1, alert2, safe1, safe2
  bootstrap_sql text,
  ssh text,                          -- json {enabled, host, port, user, useKey, keyPath, passwordMode}
  ssl text,                          -- json {mode, keyPath, certPath, caPath}
  options text,                      -- json: rowLimit, backup tool paths/options, encoding, url extras
  sort_order integer not null default 0,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index if not exists connections_group on connections(group_id);
create index if not exists connections_tag on connections(tag_id);

create table if not exists history (
  id integer primary key autoincrement,
  connection_id text not null references connections(id) on delete cascade,
  database text,
  sql text not null,
  source text not null default 'editor' check (source in ('editor','commit','user_mgmt','metrics','plugin')),
  duration_ms integer,
  error text,
  original_values text,              -- csv of rows before update/delete (optional setting)
  executed_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index if not exists history_conn_time on history(connection_id, executed_at desc);

create table if not exists table_state (
  connection_id text not null references connections(id) on delete cascade,
  object_key text not null,          -- db.schema.table
  state text not null,               -- json {filters, join, visibleColumns, widths, sort, filterVisible}
  primary key (connection_id, object_key)
);

create table if not exists editor_tabs (
  connection_id text not null references connections(id) on delete cascade,
  idx integer not null,
  title text,
  content text not null default '',
  primary key (connection_id, idx)
);

create table if not exists query_vars (
  name text primary key,
  value text not null,
  last_used_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table if not exists metrics_boards (
  id text primary key,
  name text not null,
  connection_id text references connections(id) on delete set null,
  board text not null,               -- json {objects[], links[], locked, grid}
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table if not exists diagram_layouts (
  connection_id text not null references connections(id) on delete cascade,
  schema_key text not null,
  layout text not null,              -- json {positions{}, colors{}, zoom}
  primary key (connection_id, schema_key)
);

create table if not exists settings (
  key text primary key,
  value text not null                -- json
);

insert or ignore into tags (id, name, color, builtin) values
  ('local','local','#8e8e93',1),('testing','testing','#34c759',1),('development','development','#007aff',1),
  ('staging','staging','#ff9500',1),('production','production','#ff3b30',1);
