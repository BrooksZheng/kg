import fs from "node:fs";

fs.writeFileSync(new URL("./should-not-run.executed", import.meta.url), "executed\n");
