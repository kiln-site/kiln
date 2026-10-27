import { Link } from "@tanstack/react-router"
import { Search } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import { useOpenSearch } from "~/components/search"

export function NotFound() {
  const openSearch = useOpenSearch()
  return (
    <div className="mx-auto flex max-w-xl flex-col items-start px-6 py-24 sm:py-32">
      <p className="type-technical-label text-primary-ink">404</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
        There’s no page here.
      </h1>
      <p className="mt-3 text-muted-foreground">
        It may have moved. Search for it, or start from the docs’ home.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Button className="h-10 px-4" onClick={openSearch}>
          <Search />
          Search the docs
        </Button>
        <Button asChild variant="outline" className="h-10 px-4">
          <Link to="/">Docs home</Link>
        </Button>
      </div>
    </div>
  )
}
