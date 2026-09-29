# Jeweller OS backend

Node.js / Express API, Mongoose models and MongoDB workflows.

```bash
npm ci
npm run browser:install
npm run dev
```

API health: http://localhost:4000/api/health. Without MONGODB_URI, development starts a real local MongoDB replica set and persists it in `var/dev-mongo`. Copy `.env.example` to `.env` to use your own replica set. MongoDB data lives in the database, not in React files.

- `npm run bootstrap`: create the first Ahmed Solutions administrator.
- `npm run demo`: seed development accounts and start API plus the sibling frontend (install frontend dependencies first).
- `npm start`: run Express using the configured MongoDB connection; serves `../frontend/dist` if built.
- `npm test`: isolated database, calculation and persistence tests.
- `npm run qa`: browser/API/PDF checks, after building the frontend.

See `../README.md` for complete setup and `docs/` for API, coverage and deployment details. Never add real credentials or database files to the ZIP.
# jewellery-os-backend
# jewellery-os-backend
