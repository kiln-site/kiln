import type { DatabaseEngine } from "@workspace/contracts"

import { engineOptions } from "@/components/database/database-presentation"

// Which engine a new database runs.
export function DatabaseEngineChoice({
  onChange,
  value,
}: {
  onChange: (engine: DatabaseEngine) => void
  value: DatabaseEngine
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-medium">Engine</legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {engineOptions.map((option) => (
          <button
            key={option.value}
            aria-pressed={value === option.value}
            className={`rounded-lg border px-2 py-3 text-left transition-colors ${
              value === option.value
                ? "border-primary/60 bg-primary/10 text-foreground"
                : "border-border/70 bg-background/30 text-muted-foreground hover:bg-accent/30"
            }`}
            type="button"
            onClick={() => onChange(option.value)}
          >
            <span className="type-card-title block">{option.label}</span>
            <span className="type-meta mt-0.5 block font-mono">
              {option.description}
            </span>
          </button>
        ))}
      </div>
    </fieldset>
  )
}
