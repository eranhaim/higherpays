// Local dev stack: Postgres (docker) + backend + frontend. Ctrl+C stops all of it.
//
// Postgres runs in the compose container, so there is one database for docker
// and for local dev. The backend and frontend run on the host, so they reload
// on file changes. Config comes from the root .env — the same file compose
// reads — and this script computes the connection strings the way compose
// does, so there is no second copy of the passwords.
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args) {
  return spawnSync(command, args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function fail(message) {
  process.stderr.write(`[dev] ${message}\n`);
  process.exit(1);
}

// ── Postgres ────────────────────────────────────────────────────────────────

function startPostgres() {
  process.stdout.write('[dev] starting postgres...\n');
  const up = run('docker', ['compose', 'up', '-d', 'postgres']);
  if (up.status !== 0) fail(`docker compose up failed:\n${up.stderr || up.stdout}`);
}

function waitForPostgres() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const health = run('docker', ['inspect', '-f', '{{.State.Health.Status}}', 'higherpays-pg']);
    const status = health.stdout.trim();
    if (status === 'healthy') return;
    if (Date.now() > deadline) fail(`postgres did not become healthy (last status: ${status || 'unknown'})`);
    sleep(1000);
  }
}

// The host port comes from docker-compose.override.yml, which is machine-local,
// so ask docker rather than hard-coding it.
function postgresHostPort() {
  const published = run('docker', ['compose', 'port', 'postgres', '5432']);
  const port = published.stdout.trim().split(':').pop();
  if (!port) fail('postgres has no published host port — add a ports mapping in docker-compose.override.yml');
  return port;
}

// ── Services ────────────────────────────────────────────────────────────────

function backendEnv(port) {
  for (const name of ['POSTGRES_PASSWORD', 'HP_APP_PASSWORD', 'JWT_SECRET']) {
    if (!process.env[name]) fail(`${name} is not set in the root .env`);
  }
  return {
    ...process.env,
    // The root .env is written for the deployed stack; dev overrides what differs.
    NODE_ENV: 'development',
    PORT: '3000',
    PGUSER: 'hp_app',
    DATABASE_URL: `postgres://hp_app:${process.env.HP_APP_PASSWORD}@localhost:${port}/higherpays`,
    MIGRATIONS_DATABASE_URL: `postgres://postgres:${process.env.POSTGRES_PASSWORD}@localhost:${port}/higherpays`,
  };
}

const children = [];
let stopping = false;

function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
}

function start(name, dir, env) {
  const child = spawn(npm, ['run', 'dev'], {
    cwd: path.join(root, dir),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  children.push(child);

  const prefix = `[${name}] `;
  for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of chunk.replace(/\n$/, '').split('\n')) target.write(prefix + line + '\n');
    });
  }

  child.on('exit', (code) => {
    if (stopping) return;
    process.stdout.write(`${prefix}exited with code ${code}\n`);
    process.exitCode = code ?? 1;
    stopAll();
  });
}

startPostgres();
waitForPostgres();
const env = backendEnv(postgresHostPort());
start('backend', 'backend', env);
start('frontend', 'frontend', process.env);

process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
