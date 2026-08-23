import { cn } from "@workspace/ui/lib/utils"

import { useKilnGitRepository } from "@/lib/git-repository"
import { footerSocialLinkIds, socialLinks } from "@/lib/social-links"

export function PanelFooter({ className }: { className?: string }) {
  const gitRepository = useKilnGitRepository()
  const commit = import.meta.env.VITE_KILN_BUILD_SHA.trim()
  const commitUrl = commit ? `${gitRepository}/commit/${commit}` : null
  const shortCommit = commit.slice(0, 7)
  const year = new Date().getUTCFullYear()

  return (
    <footer
      aria-label="Hearth Panel build information"
      className={cn(
        "type-meta hidden h-14 shrink-0 grid-cols-[minmax(0,1fr)_auto] grid-rows-2 bg-background text-center tracking-wide text-muted-foreground sm:grid sm:grid-cols-[minmax(4.5rem,1fr)_auto_minmax(4.5rem,1fr)]",
        className
      )}
    >
      <div className="col-start-1 row-start-1 flex items-center gap-1.5 self-end justify-self-center pb-0.5 whitespace-nowrap sm:col-start-2">
        <span className="text-muted-foreground">Kiln · Hearth Panel</span>
        {commitUrl ? (
          <a
            href={commitUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`View deployed commit ${commit}`}
            className="font-mono text-primary/90 transition-colors hover:text-primary focus-visible:text-primary focus-visible:outline-none"
          >
            {shortCommit}
          </a>
        ) : (
          <span className="font-mono text-primary/80">Development</span>
        )}
      </div>
      <div className="col-start-1 row-start-2 flex items-center justify-center gap-x-2 self-start justify-self-center pt-0.5 whitespace-nowrap sm:col-start-2">
        <span className="flex items-center gap-1">
          <span>QuartzDev</span>
          <span aria-label="Copyright">©</span>
          <time dateTime={String(year)}>{year}</time>
        </span>
        <span className="text-border" aria-hidden="true">
          /
        </span>
        <FooterLink href="/terms">Terms of Use</FooterLink>
        <FooterLink href="/privacy">Privacy Policy</FooterLink>
      </div>
      <div className="col-start-2 row-span-2 row-start-1 flex h-full justify-self-end px-1 sm:col-start-3">
        <FooterBrandLink
          href="https://quartzdev.gg/"
          label="QuartzDev"
          title="QuartzDev"
          src="/branding/quartzdev-black.svg"
        />
        {footerSocialLinkIds.map((id) => {
          const link = socialLinks[id]
          return (
            <FooterBrandLink
              key={id}
              href={link.href}
              label={link.label}
              title={link.title}
              src={link.icon}
            />
          )
        })}
      </div>
    </footer>
  )
}

function FooterBrandLink({
  href,
  label,
  src,
  title,
}: {
  href: string
  label: string
  src: string
  title: string
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      title={title}
      className="grid h-full w-9 place-items-center text-muted-foreground/90 transition-colors outline-none hover:bg-primary/10 hover:text-primary focus-visible:bg-primary/12 focus-visible:text-primary focus-visible:ring-1 focus-visible:ring-ring/40 focus-visible:ring-inset"
    >
      <BrandIcon src={src} className="size-5" />
    </a>
  )
}

function FooterLink({ children, href }: { children: string; href: string }) {
  return (
    <a
      href={href}
      className="transition-colors outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-1 focus-visible:ring-ring/40"
    >
      {children}
    </a>
  )
}

function BrandIcon({ className, src }: { className?: string; src: string }) {
  return (
    <span
      aria-hidden="true"
      className={`block bg-current ${className ?? ""}`}
      style={{
        mask: `url(${src}) center / contain no-repeat`,
        WebkitMask: `url(${src}) center / contain no-repeat`,
      }}
    />
  )
}
