import { redirect } from "next/navigation";
import { Workspace } from "@/components/workspace";
import { currentUser } from "@/lib/server/auth";
import { listRuns } from "@/lib/server/db";

export default async function AppPage() {
  const user = await currentUser();
  if (!user) redirect("/sign-in");
  return <Workspace key={user.id} username={user.username} initialRuns={await listRuns(user.id)} />;
}
