import { ARM_LABEL, ARMS } from "./data";

export function Panel({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3 border-b border-border px-4 py-5 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold">{title}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function ArmLegend() {
  return (
    <ul className="flex gap-4 text-xs text-muted-foreground">
      {ARMS.map((arm) => (
        <li key={arm} className="flex items-center gap-1.5">
          <span
            className={`size-2 rounded-[2px] ${arm === "optimized" ? "bg-arm-optimized" : "bg-arm-baseline"}`}
          />
          {ARM_LABEL[arm]}
        </li>
      ))}
    </ul>
  );
}
