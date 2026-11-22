// Page title row: title, one plain sentence about the page, and optional actions on the right.
export default function PageHeader({ title, description, actions }) {
  return (
    <header className="flex flex-wrap items-end gap-x-4 gap-y-2">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-0.5 max-w-3xl text-[13px] leading-relaxed text-ink-2">{description}</p>}
      </div>
      {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
