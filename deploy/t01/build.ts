import { serverEnvironment } from "./environment";

const child = Bun.spawn([process.execPath, "run", "build"], {
  env: serverEnvironment(process.env),
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
