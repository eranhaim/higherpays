# HigherPays

Multi-tenant SaaS for creator agencies. Card data never touches this system — payments happen on the provider's hosted page — so the app is out of PCI scope.

## Repository layout

```
higherpays/
├── frontend/    React + TypeScript + Vite (the operator/agency console)
├── backend/     Node + Express + PostgreSQL (the API, the money engine)
└── docker-compose.yml   Local Postgres for development
```

## Quick start (local development)

Prerequisites: **Node 20+**, **Docker Desktop**, **npm**.

```bash
# 1. Start Postgres
docker compose up -d postgres

# 2. Backend
cd backend
npm install
cp .env.example .env       # then edit if needed; defaults work for local dev
npm run migrate            # applies all SQL migrations
npm run seed               # creates a demo agency + owner login
npm start                  # http://localhost:3000

# 3. Frontend (new terminal)
cd frontend
npm install
npm run dev                # http://localhost:5173
```

The frontend dev server proxies API calls to the backend on `localhost:3000`.

Seeded logins: two demo agencies with one login per role, printed by `npm run seed`.
Password for all of them is `SEED_PASSWORD` (default `higherpays123`).

## Running database migrations

The backend requires two Postgres roles: one **owner** who runs migrations, one restricted **app role** (`hp_app`) the server connects as, which cannot alter the schema.

Migrations must run as the owner:

```bash
cd backend
DATABASE_URL=postgres://postgres:devpass@localhost:5432/higherpays npm run migrate
```

The seed script does the same. After the schema is created, `.env` should point `DATABASE_URL` at `hp_app`, the restricted runtime role. See [`backend/README.md`](backend/README.md) for the full setup, including the SQL to create `hp_app`.

## Tests

```bash
cd backend
npm test           # unit tests, no DB required
npm run test:db    # fee-engine tests, needs a TEST_DATABASE_URL
```

## Where things live

| Concern | Path |
|---|---|
| React app entry | `frontend/src/main.tsx` |
| Routes / pages | `frontend/src/pages/*` |
| API client | `frontend/src/api/*` |
| Business logic (client) | `frontend/src/business/*` |
| Express server | `backend/src/server.js` |
| HTTP routes | `backend/src/routes/*` |
| MantaPay adapter | `backend/src/providers/mantapay-*.js` |
| SQL schema | `backend/migrations/*.sql` |
| Money engine (SQL) | `backend/migrations/007_payout_engine.sql`, `019_fixed_fee_and_refunds.sql`, `026_fee_model_cascade.sql`, `027_fee_itemisation.sql` |

More detail in [`backend/README.md`](backend/README.md).
