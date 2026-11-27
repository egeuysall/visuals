import Link from "next/link";

const navLink =
  "text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground";

/** Same frame as kaibo: narrow column, wordmark and account links on top. */
export function SiteShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-155 flex-col px-6 py-8 sm:px-8 sm:py-10">
      <header className="flex items-end justify-between gap-6 pb-8">
        <Link href="/" className="text-[15px] font-semibold hover:text-muted-foreground">
          visuals
        </Link>
        <nav className="flex items-center gap-4" aria-label="account">
          <Link href="/sign-in" className={navLink}>
            sign in
          </Link>
          <Link href="/sign-up" className={navLink}>
            sign up
          </Link>
        </nav>
      </header>
      <main className="flex-1 pb-8">{children}</main>
    </div>
  );
}
