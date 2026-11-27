import Link from "next/link";

const navLink =
  "text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground";

/** Same frame as kaibo: wordmark and account links on top. `wide` leaves room for charts. */
export function SiteShell({ wide, children }: { wide?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={`mx-auto flex min-h-dvh w-full flex-col px-4 py-8 sm:px-8 sm:py-10 ${wide ? "max-w-5xl" : "max-w-155"}`}
    >
      <header className={`flex items-end justify-between gap-6 ${wide ? "pb-12" : "pb-8"}`}>
        <Link href="/" className="text-[15px] font-semibold hover:text-muted-foreground">
          sdk
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
