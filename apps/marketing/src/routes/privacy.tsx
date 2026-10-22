import { createFileRoute } from "@tanstack/react-router"

import {
  ContactEmail,
  LegalList,
  LegalPage,
  LegalSection,
} from "~/components/legal-page"
import { pageHead } from "~/lib/seo"

export const Route = createFileRoute("/privacy")({
  head: ({ matches }) =>
    pageHead({
      description:
        "What Hearth, Kiln's web panel, handles, how it's used, and who to contact about your data.",
      matches,
      path: "/privacy",
      title: "Privacy Policy | Kiln",
    }),
  component: PrivacyRoute,
})

function PrivacyRoute() {
  return (
    <LegalPage title="Privacy Policy" updated="October 22, 2026">
      <LegalSection title="What Hearth handles">
        <p>
          Hearth processes the information needed to authenticate users and
          operate the control plane. Depending on your deployment, this can
          include:
        </p>
        <LegalList>
          <li>account details such as your name, email, and session data;</li>
          <li>Relay settings, encrypted Relay credentials, and permissions;</li>
          <li>instance metadata, resource state, and operational errors; and</li>
          <li>
            server files, console output, and commands when you request those
            features.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection title="How we use it">
        <p>
          We use this information to sign users in, enforce permissions,
          connect to Relays, deliver commands, show server state, send required
          account messages, and protect the panel from misuse.
        </p>
      </LegalSection>

      <LegalSection title="Sharing and external services">
        <p>
          Hearth shares data only as needed to provide the requested feature or
          operate the deployment. This can include the database, email
          delivery, hosting infrastructure, and the Relay or node operator
          configured for your panel.
        </p>
        <p>
          If you choose to share a log, Hearth sends the selected or latest log
          to mclo.gs and gives you its link. Review that service’s policy before
          sharing sensitive content. Links to Discord, GitHub, and other
          services are third-party destinations.
        </p>
      </LegalSection>

      <LegalSection title="Cookies, retention, and security">
        <p>
          Hearth uses essential session cookies and a small preference cookie;
          it does not need advertising cookies to operate. Account, Relay, and
          operational records are retained according to the deployment’s
          storage and backup practices. Relay credentials are encrypted at rest
          with the application secret, but no internet service can promise
          perfect security.
        </p>
      </LegalSection>

      <LegalSection title="Your choices">
        <p>
          You can stop using Hearth, remove connected Relays through an
          authorized administrator, and avoid optional sharing such as mclo.gs
          uploads. For account or data requests, email QuartzDev at{" "}
          <ContactEmail />. If someone else runs your panel, contact them too.
        </p>
      </LegalSection>

      <LegalSection title="Updates">
        <p>
          We may update this Privacy Policy as Hearth changes. The effective date
          above identifies the current version. Questions can be sent to{" "}
          <ContactEmail />.
        </p>
      </LegalSection>
    </LegalPage>
  )
}
