import { createEchoProvider, createRuntime } from "@runto/core";
import { createGatewayServer } from "@runto/gateway";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "run") {
    const taskIndex = rest.indexOf("--task");
    const task = taskIndex >= 0 ? rest[taskIndex + 1] : rest.join(" ");
    if (!task) throw new Error('Usage: navo run --task "your task"');
    const runtime = createRuntime({
      provider: createEchoProvider(),
      telemetry: { exporter: "jsonl" },
    });
    console.log(JSON.stringify(await runtime.run({ task }), null, 2));
    return;
  }
  if (command === "serve") {
    const app = await createGatewayServer();
    await app.listen();
    console.log(`Gateway listening on http://${app.host}:${app.port}`);
    return;
  }
  if (command === "help" || !command) {
    console.log("navo run --task <task>\nnavo serve");
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
