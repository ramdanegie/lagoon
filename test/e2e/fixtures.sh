#!/usr/bin/env bash
# Start throwaway database servers for the e2e suites (never touches services you already run).
#   ./test/e2e/fixtures.sh up     -> Postgres :54400, MySQL :33100, Redis :6400, MongoDB :27100, SQLite file
#   ./test/e2e/fixtures.sh down   -> stop them and delete their data
# Needs Homebrew binaries: postgresql, mysql, redis, mongodb-community, sqlite3.
set -euo pipefail
STATE=/tmp/lagoon-e2e
case "${1:-up}" in
up)
  mkdir -p "$STATE"
  initdb -D "$STATE/pg" -U tc -A trust >/dev/null
  pg_ctl -D "$STATE/pg" -o "-p 54400 -k /tmp" -l "$STATE/pg.log" start >/dev/null
  psql -h /tmp -p 54400 -U tc -d postgres -qc "create database shop"
  psql -h /tmp -p 54400 -U tc -d shop -q <<'SQL'
create table customers (id serial primary key, name text not null, email text unique, city text, created_at timestamptz default now());
create table orders (id serial primary key, customer_id int references customers(id) on delete cascade, total numeric(10,2) not null, status text default 'pending', meta jsonb);
create table nokey (a int, b text);
insert into customers (name, email, city) select 'Customer ' || g, 'c' || g || '@example.com', (array['Berlin','Jakarta','Paris','Tokyo'])[1 + g % 4] from generate_series(1, 750) g;
insert into orders (customer_id, total, status, meta) select 1 + (g % 750), (g * 7 % 500) + 0.99, (array['pending','paid','shipped'])[1 + g % 3], jsonb_build_object('items', g % 5) from generate_series(1, 2000) g;
insert into nokey values (1,'x'),(1,'x'),(2,'y');
create view order_summary as select c.city, count(*) n, sum(o.total) revenue from orders o join customers c on c.id = o.customer_id group by c.city;
create function double_it(x int) returns int language sql as $$ select x * 2 $$;
SQL
  redis-server --port 6400 --save '' --daemonize yes --dir "$STATE" >/dev/null
  redis-cli -p 6400 hset user:1 name Ana city Jakarta >/dev/null; redis-cli -p 6400 set greeting "hello world" >/dev/null
  redis-cli -p 6400 rpush queue a b c >/dev/null; redis-cli -p 6400 zadd scores 10 ana 20 budi >/dev/null
  mkdir -p "$STATE/mongo"; mongod --dbpath "$STATE/mongo" --port 27100 --fork --logpath "$STATE/mongo.log" --bind_ip 127.0.0.1 >/dev/null
  mysqld --initialize-insecure --datadir="$STATE/mysql" --user="$(whoami)" >/dev/null 2>&1
  (mysqld --datadir="$STATE/mysql" --port=33100 --socket="$STATE/mysql.sock" --mysqlx=OFF --bind-address=127.0.0.1 >"$STATE/mysql.log" 2>&1 &)
  for _ in $(seq 1 40); do mysql -h127.0.0.1 -P33100 -uroot -e "select 1" >/dev/null 2>&1 && break; sleep 1; done
  mysql -h127.0.0.1 -P33100 -uroot -e "create database shop; create table shop.products (id int auto_increment primary key, name varchar(100) not null, price decimal(10,2), active bit(1) default 1, tags json); insert into shop.products (name, price, tags) values ('Pen', 1.50, '[\"office\"]'), ('Desk', 199.00, '[\"furniture\"]'), ('Lamp', 25.99, null);"
  sqlite3 "$STATE/app.sqlite" "create table notes(id integer primary key, title text, body text); insert into notes(title,body) values ('a','x'),('b','y');"
  echo "fixtures up. SQLite file: $STATE/app.sqlite  (export TC_SQLITE=$STATE/app.sqlite)"
  ;;
down)
  redis-cli -p 6400 shutdown nosave 2>/dev/null || true
  [ -d "$STATE/mongo" ] && mongod --dbpath "$STATE/mongo" --shutdown >/dev/null 2>&1 || true
  pkill -f "mongod --dbpath $STATE/mongo" 2>/dev/null || true
  mysqladmin -h127.0.0.1 -P33100 -uroot shutdown 2>/dev/null || true
  [ -d "$STATE/pg" ] && pg_ctl -D "$STATE/pg" stop >/dev/null 2>&1 || true
  sleep 1
  rm -rf "$STATE"
  echo "fixtures down"
  ;;
esac
