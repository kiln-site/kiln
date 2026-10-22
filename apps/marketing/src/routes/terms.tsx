import { createFileRoute } from "@tanstack/react-router"

import {
  ContactEmail,
  LegalList,
  LegalPage,
  LegalSection,
} from "~/components/legal-page"
import { pageHead } from "~/lib/seo"

export const Route = createFileRoute("/terms")({
  head: ({ matches }) =>
    pageHead({
      description:
        "The terms for using Hearth, Kiln's web panel, and how Kiln is licensed.",
      matches,
      path: "/terms",
      title: "Terms of Use | Kiln",
    }),
  component: TermsRoute,
})

function TermsRoute() {
  return (
    <LegalPage title="Terms of Use" updated="August 6, 2026">
      <LegalSection title="Using Hearth">
        <p>
          These Terms govern your use of Hearth Panel, the Kiln control plane
          operated by Marco Technology Consulting Inc. (“QuartzDev”). Hearth
          connects to Relays and helps you manage game server instances, files,
          logs, and console access.
        </p>
        <p>
          By signing in to or using Hearth, you agree to these Terms. If you do
          not agree, do not use the panel.
        </p>
      </LegalSection>

      <LegalSection title="Accounts and access">
        <p>
          Keep your account details, passwords, session credentials, and Relay
          tokens secure. You are responsible for activity performed through
          your account and for granting the right people access to your
          instances.
        </p>
      </LegalSection>

      <LegalSection title="Your servers and content">
        <p>
          You keep ownership of the servers, files, logs, commands, and other
          content you connect to or submit through Hearth. You are responsible
          for that content, its legality, and your right to use it.
        </p>
      </LegalSection>

      <LegalSection title="Acceptable use">
        <p>Do not use Hearth or a connected Relay to:</p>
        <LegalList>
          <li>break the law or infringe another person’s rights;</li>
          <li>bypass access controls, probe, attack, or disrupt systems;</li>
          <li>distribute malware, abuse, spam, or unauthorized content; or</li>
          <li>interfere with Hearth, its Relays, or another user’s service.</li>
        </LegalList>
      </LegalSection>

      <LegalSection title="Availability and changes">
        <p>
          Hearth is a control plane, not a promise that a connected game server
          or Relay will be available. Deployments, nodes, runtimes, backups, and
          retention may be managed by you or another operator. We may change,
          suspend, or discontinue Hearth for maintenance, security, or a Terms
          violation.
        </p>
      </LegalSection>

      <LegalSection title="Software licensing">
        <p>
          Kiln (including Hearth, Relay, Bricks, Embers, and related components
          in this project) uses a dual-license model from Marco Technology
          Consulting Inc. (“QuartzDev”). The open-source license is the GNU
          Affero General Public License v3.0 (AGPL-3.0). Anyone may use,
          modify, and run the software—including for commercial purposes—if
          they comply with AGPL-3.0, including its copyleft and network-use
          source disclosure requirements.
        </p>
        <p>
          A paid Kiln Commercial License is available as an alternative if you
          cannot or prefer not to comply with AGPL-3.0—for example, to keep
          modifications proprietary, offer a modified panel as a hosted service
          without AGPL §13 source disclosure, or obtain contractual commercial
          terms. The Commercial License includes rights to use, modify, create
          derivative works, and sublicense those works to end users without
          AGPL copyleft, as described in COMMERCIAL_LICENSE.md in the project
          repository. Contact QuartzDev at <ContactEmail /> to purchase a
          license.
        </p>
        <p>
          Outside contributions to the public repository require a Contributor
          License Agreement with Marco Technology Consulting Inc. (“QuartzDev”)
          so QuartzDev can license those contributions under both AGPL-3.0 and
          the Commercial License. Third-party dependencies bundled with Hearth
          keep their own licenses. Minecraft, mods, plugins, game runtimes,
          Relays you operate, and linked services have their own terms and are
          not operated by Hearth unless we say otherwise.
        </p>
      </LegalSection>

      <LegalSection title="Disclaimers and liability">
        <p>
          Hearth is provided “as is” and “as available.” To the maximum extent
          permitted by law, Marco Technology Consulting Inc. (“QuartzDev”) is
          not responsible for indirect losses, downtime, or lost content
          resulting from your use of Hearth or a connected service. Nothing in
          these Terms limits rights that cannot be limited by law.
        </p>
      </LegalSection>

      <LegalSection title="Updates and contact">
        <p>
          We may update these Terms by posting a new version here. Continued use
          after an update means you accept the revised Terms. Questions can be
          sent to <ContactEmail />.
        </p>
      </LegalSection>
    </LegalPage>
  )
}
