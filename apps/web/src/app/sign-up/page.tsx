import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { SiteShell } from "@/components/site-shell";
import { currentUser } from "@/lib/server/auth";

export default async function Page() {
  if (await currentUser()) redirect("/app");
  return (
    <SiteShell>
      <AuthForm mode="sign-up" />
    </SiteShell>
  );
}
