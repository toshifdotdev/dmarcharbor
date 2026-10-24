// `npm run dev`: the API in watch mode with NODE_ENV=development.
//
// env.ts treats an unset NODE_ENV as production on purpose, so a deploy that
// forgets it fails closed. That made `npm run dev` refuse to start on a fresh
// checkout ("Production requires EMAIL_PROVIDER=resend"), and the inline
// `NODE_ENV=development tsx ...` form does not work in Windows shells. This sets
// it for the dev process only; an explicit NODE_ENV in the shell still wins.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

const child = spawn(process.execPath, [tsxCli, "watch", "src/server.ts"], {
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? "development" },
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
