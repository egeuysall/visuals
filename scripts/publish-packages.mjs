import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dryRun = process.argv.includes("--dry-run");
const packageDirectories = [];
for (const parent of ["packages", "services"]) {
  for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
    if (entry.isDirectory()) packageDirectories.push(join(root, parent, entry.name));
  }
}

const publishable = [];
for (const directory of packageDirectories) {
  const packageJson = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  if (!packageJson.private) publishable.push({ directory, name: packageJson.name });
}

const destination = await mkdtemp(join(tmpdir(), "runto-publish-"));
try {
  for (const entry of publishable) {
    execFileSync("pnpm", ["pack", "--pack-destination", destination], {
      cwd: entry.directory,
      stdio: "inherit",
    });
  }
  const tarballs = (await readdir(destination)).filter((file) => file.endsWith(".tgz")).sort();
  if (tarballs.length !== publishable.length)
    throw new Error(`Expected ${publishable.length} package tarballs, found ${tarballs.length}`);
  if (dryRun) {
    console.log(`Prepared ${tarballs.length} public package tarballs.`);
  } else {
    for (const tarball of tarballs)
      execFileSync("npm", ["publish", join(destination, tarball), "--access", "public"], {
        cwd: root,
        stdio: "inherit",
      });
  }
} finally {
  await rm(destination, { recursive: true, force: true });
}
