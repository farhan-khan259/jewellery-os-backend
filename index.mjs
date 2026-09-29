import "dotenv/config";
import { connect } from "./db.mjs";
import { createApp } from "./app.mjs";
await connect();
console.log("MongoDB successfully running");
const server = createApp().listen(process.env.PORT || 4000, "0.0.0.0", () =>
  console.log("Jeweller OS API ready"),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => server.close(() => process.exit(0)));
