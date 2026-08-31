import { type Metadata } from "next";
import Link from "next/link";
import { InfoNav } from "../_components/InfoNav";
import { InfoFooter } from "../_components/InfoFooter";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "Privacy Policy for Transit Planner — how data is collected, stored, shared with AI and analytics providers, and handled in the application.",
  robots: { index: true, follow: false },
};

const LAST_UPDATED = "August 31, 2026";

const privacySections = [
  {
    number: "1",
    title: "Overview",
    content: (
      <p style={{ fontSize: 14.5, color: "#57534e", lineHeight: 1.75 }}>
        This Privacy Policy describes common data flows in Transit Planner deployments. Actual data handling can
        vary depending on how the app is deployed — local, self-hosted, or hosted. The operator of your deployment
        is the "data controller" for most uses.
      </p>
    ),
  },
  {
    number: "2",
    title: "Information We Collect",
    content: (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {[
          {
            label: "Account information",
            desc: "If sign-in is enabled, your name, email, and profile image may be provided by the authentication provider.",
          },
          {
            label: "User content",
            desc: "Routes, stops, boundaries, uploads, and messages you submit (including AI prompts and planning context).",
          },
          {
            label: "AI conversations",
            desc: "When you use the AI assistant, your message and the assistant's reply are processed, along with the tools it runs on your behalf and the arguments and results of those tools — for example a map area you asked about, or the ranked service-gap results returned for it.",
          },
          {
            label: "Feedback and bug reports",
            desc: "If you submit feedback, the message you write and the name you optionally provide are sent to the deployment operator.",
          },
          {
            label: "Network and approximate location",
            desc: "Your IP address, and coarse location derived from it by the hosting provider — country, region, city, approximate coordinates, postal code, and timezone. This is derived from the network connection, not from device GPS, and is approximate.",
          },
          {
            label: "Usage data",
            desc: "Basic logs and product analytics used to operate, secure, and improve the service — for example, request metadata, error logs, page loads, feature usage, overlay toggles, lines created, stations placed, portals added, import/export actions, and analysis-tool activity.",
          },
        ].map((item) => (
          <div
            key={item.label}
            style={{
              padding: "14px 16px", borderRadius: 10,
              border: "1px solid #e7e5e4", backgroundColor: "#fafaf9",
              display: "flex", gap: 12,
            }}
          >
            <div
              style={{
                fontSize: 12, fontWeight: 600, color: "#2563eb",
                backgroundColor: "#eff6ff", padding: "3px 8px",
                borderRadius: 5, flexShrink: 0, alignSelf: "flex-start",
                whiteSpace: "nowrap",
              }}
            >
              {item.label}
            </div>
            <span style={{ fontSize: 13.5, color: "#57534e", lineHeight: 1.65 }}>{item.desc}</span>
          </div>
        ))}
      </div>
    ),
  },
  {
    number: "3",
    title: "How We Use Information",
    content: (
      <ul style={{ paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
        {[
          "Provide core functionality — map editing, imports/exports, AI-assisted workflows.",
          "Maintain session history and recover work, where enabled.",
          "Measure product usage and understand which tools are used most often, such as route generation, council workflows, overlays, and network-building actions.",
          "Debug and improve AI quality — recorded traces of an AI turn let the operator see which tool the assistant chose, what it received back, and where an answer went wrong.",
          "Notify the deployment operator of activity such as new visits, submitted feedback, and reported bugs.",
          "Monitor performance, troubleshoot errors, and prevent abuse.",
        ].map((item, i) => (
          <li key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <div style={{ width: 5, height: 5, borderRadius: "50%", backgroundColor: "#2563eb", marginTop: 9, flexShrink: 0 }} />
            <span style={{ fontSize: 14.5, color: "#57534e", lineHeight: 1.75 }}>{item}</span>
          </li>
        ))}
      </ul>
    ),
  },
  {
    number: "4",
    title: "Sharing and Third Parties",
    content: (
      <>
        <p style={{ fontSize: 14.5, color: "#57534e", lineHeight: 1.75, marginBottom: 14 }}>
          Transit Planner may send data to third-party services depending on enabled features:
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[
            {
              label: "Map rendering",
              desc: "Map tile requests may be sent to a map provider (e.g., Mapbox). Their privacy policy applies.",
              color: "#dc2626", bg: "#fff1f2",
            },
            {
              label: "Authentication",
              desc: "Sign-in can be handled by an identity provider (e.g., Auth0). Your profile data is managed by that provider.",
              color: "#d97706", bg: "#fffbeb",
            },
            {
              label: "Analytics",
              desc: "If analytics are enabled for a deployment, usage events may be sent to Mixpanel. These events can include page visits, feature usage, counts of lines and stations in a plan, station-placement and line-creation actions, analysis-tool usage, and related product interaction metadata.",
              color: "#16a34a", bg: "#f0fdf4",
            },
            {
              label: "AI services",
              desc: "When AI features are used, your prompts and the surrounding planning context are sent to the configured model provider (Anthropic, or Google Gemini) to generate a response. Their privacy policy applies.",
              color: "#7c3aed", bg: "#f5f3ff",
            },
            {
              label: "AI observability",
              desc: "If tracing is enabled for a deployment, a record of each AI turn may be sent to Langfuse. A trace includes your message, the assistant's reply, the tools it called with their arguments and results, and the model name, token counts, and estimated cost. The Langfuse project used by a deployment may be hosted in the United States or the European Union, depending on how the operator configured it.",
              color: "#0d9488", bg: "#f0fdfa",
            },
            {
              label: "Operator notifications",
              desc: "If webhooks are configured, the app posts activity notices to the operator's Discord workspace. These can include visit events with the IP address and derived approximate location described in section 2, the first 200 characters of an AI chat message, council planning request details, and the full text of feedback and bug reports.",
              color: "#4f46e5", bg: "#eef2ff",
            },
            {
              label: "Text-to-speech",
              desc: "If enabled, selected text may be sent to a speech provider (ElevenLabs) to generate audio output.",
              color: "#0891b2", bg: "#ecfeff",
            },
            {
              label: "Hosting and data storage",
              desc: "Application data and the reference datasets behind planning tools are stored with the deployment's backend provider (Supabase). Hosted deployments run on a cloud host (Vercel), which processes requests and provides the approximate-location headers noted above.",
              color: "#57534e", bg: "#f5f5f4",
            },
          ].map((item) => (
            <div
              key={item.label}
              style={{
                padding: "12px 14px", borderRadius: 10,
                backgroundColor: item.bg, border: `1px solid ${item.bg}`,
                display: "flex", gap: 10, alignItems: "flex-start",
              }}
            >
              <span
                style={{
                  fontSize: 12, fontWeight: 600, color: item.color,
                  backgroundColor: "white", padding: "3px 8px",
                  borderRadius: 5, flexShrink: 0, whiteSpace: "nowrap",
                }}
              >
                {item.label}
              </span>
              <span style={{ fontSize: 13.5, color: "#57534e", lineHeight: 1.6 }}>{item.desc}</span>
            </div>
          ))}
        </div>
      </>
    ),
  },
  {
    number: "5",
    title: "Data Retention",
    content: (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ fontSize: 14.5, color: "#57534e", lineHeight: 1.75 }}>
          Retention depends on deployment configuration. Local and self-hosted deployments can choose to retain data
          only on the local machine or server. Hosted deployments may retain data to support features like session
          history and auditing. Contact your deployment operator for their specific retention policy.
        </p>
        <p style={{ fontSize: 14.5, color: "#57534e", lineHeight: 1.75 }}>
          Information already sent to the third parties in section 4 is retained under their policies and settings,
          not this one. In practice that means notifications posted to an operator&rsquo;s Discord workspace persist in
          that channel until someone deletes them, and AI traces persist for the retention period configured on the
          operator&rsquo;s Langfuse project. AI conversation state itself is held in server memory for an active session
          and is lost when the server restarts.
        </p>
      </div>
    ),
  },
  {
    number: "6",
    title: "Analytics, Cookies, and Similar Technologies",
    content: (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ fontSize: 14.5, color: "#57534e", lineHeight: 1.75 }}>
          Hosted deployments may use analytics and browser storage technologies to understand how the app is used and
          to keep certain preferences or sessions working correctly. Where Mixpanel is enabled, the app may store a
          browser identifier and record product events tied to app usage.
        </p>
        <p style={{ fontSize: 14.5, color: "#57534e", lineHeight: 1.75 }}>
          Depending on configuration, analytics events may include items such as page loads, feature toggles, route
          generation requests, council-tool activity, imports and exports, total lines and stations in a project,
          lines created, stations moved or placed, portals added, and related interaction metadata. If a user is
          signed in, analytics may also be associated with that account identifier.
        </p>
      </div>
    ),
  },
  {
    number: "7",
    title: "Security",
    content: (
      <p style={{ fontSize: 14.5, color: "#57534e", lineHeight: 1.75 }}>
        We use reasonable administrative and technical measures designed to protect information. No method of
        transmission or storage is completely secure. We encourage you to use strong, unique credentials and to
        report suspected security issues to your deployment operator.
      </p>
    ),
  },
  {
    number: "8",
    title: "Your Choices",
    content: (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ fontSize: 14.5, color: "#57534e", lineHeight: 1.75 }}>
          Your choices depend on the deployment you are using. Local and self-hosted deployments may allow the
          operator to disable analytics entirely. Hosted deployments may also offer browser controls, privacy tools,
          or account settings that affect analytics and stored data.
        </p>
        <p style={{ fontSize: 14.5, color: "#57534e", lineHeight: 1.75 }}>
          This build honours a browser-level opt-out: setting a{" "}
          <code style={{ fontSize: 13, backgroundColor: "#f5f5f4", padding: "1px 5px", borderRadius: 4 }}>
            skip_tracking
          </code>{" "}
          key to any non-empty value in your browser local storage stops product analytics and visit reporting from
          that browser. Because it is stored per browser, it does not carry across devices, and clearing site data
          removes it. It does not affect the AI features described in sections 2 and 4 — if you do not want your
          conversations processed or recorded, do not use the AI assistant.
        </p>
        <p style={{ fontSize: 14.5, color: "#57534e", lineHeight: 1.75 }}>
          If you want data deleted, exported, or corrected, contact the operator of your deployment. If you run
          Transit Planner yourself, you control those choices directly.
        </p>
      </div>
    ),
  },
  {
    number: "9",
    title: "Contact",
    content: (
      <p style={{ fontSize: 14.5, color: "#57534e", lineHeight: 1.75 }}>
        For privacy questions, contact the operator of your deployment. If you are running Transit Planner locally,
        you control your own data and are your own data controller.
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <div style={{ minHeight: "100vh", backgroundColor: "#ffffff" }}>
      <InfoNav />

      {/* Page header */}
      <div style={{ borderBottom: "1px solid #e7e5e4", backgroundColor: "#fafaf9", padding: "40px 24px 36px" }}>
        <div style={{ maxWidth: 800, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <Link href="/docs" style={{ fontSize: 13, color: "#a8a29e", textDecoration: "none" }}>Docs</Link>
            <span style={{ color: "#d6d3d1" }}>/</span>
            <span style={{ fontSize: 13, color: "#57534e", fontWeight: 500 }}>Privacy Policy</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <div
              style={{
                width: 40, height: 40, borderRadius: 10,
                backgroundColor: "#f0fdf4",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="#16a34a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <h1
              style={{
                fontFamily: "Google Sans Display",
                fontSize: "clamp(26px, 3.5vw, 36px)",
                fontWeight: 700, color: "#1c1917",
                letterSpacing: "-0.02em",
              }}
            >
              Privacy Policy
            </h1>
          </div>
          <p style={{ fontSize: 15, color: "#78716c", maxWidth: 560 }}>
            How Transit Planner handles information — including AI conversations, approximate location, analytics, and
            product usage tracking — in a typical deployment.
          </p>
          <p style={{ fontSize: 12, color: "#a8a29e", marginTop: 10 }}>Last updated: {LAST_UPDATED}</p>
        </div>
      </div>

      {/* Content */}
      <div style={{ maxWidth: 800, margin: "0 auto", padding: "48px 24px 80px" }}>
        {/* Template note */}
        <div
          style={{
            padding: "14px 18px", borderRadius: 10,
            backgroundColor: "#fffbeb", border: "1px solid #fde68a",
            marginBottom: 36, display: "flex", gap: 12, alignItems: "flex-start",
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, marginTop: 1 }}>
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="#d97706" strokeWidth="2" strokeLinecap="round" />
            <path d="M12 9v4M12 17h.01" stroke="#d97706" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <p style={{ fontSize: 13.5, color: "#92400e", lineHeight: 1.65, margin: 0 }}>
            <strong>Note:</strong> This document reflects the current app behavior, including analytics instrumentation,
            but it should still be reviewed by counsel for your organization's specific deployment and legal needs.
          </p>
        </div>

        {/* TOC */}
        <div
          style={{
            padding: "20px 24px", borderRadius: 12,
            border: "1px solid #e7e5e4", backgroundColor: "#fafaf9",
            marginBottom: 40,
          }}
        >
          <p style={{ fontSize: 13, fontWeight: 600, color: "#1c1917", marginBottom: 12 }}>Table of Contents</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 0", flexDirection: "column" }}>
            {privacySections.map((s) => (
              <a
                key={s.number}
                href={`#section-${s.number}`}
                style={{
                  fontSize: 13.5, color: "#57534e", textDecoration: "none",
                  padding: "3px 0", display: "flex", gap: 8, alignItems: "center",
                }}
              >
                <span style={{ fontSize: 12, color: "#a8a29e", width: 16 }}>{s.number}.</span>
                {s.title}
              </a>
            ))}
          </div>
        </div>

        {/* Sections */}
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {privacySections.map((section, i) => (
            <div
              key={section.number}
              id={`section-${section.number}`}
              style={{
                paddingTop: i === 0 ? 0 : 36,
                paddingBottom: 36,
                borderBottom: i < privacySections.length - 1 ? "1px solid #f5f5f4" : "none",
                scrollMarginTop: 80,
              }}
            >
              <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                <div
                  style={{
                    width: 28, height: 28, borderRadius: 7,
                    backgroundColor: "#f0fdf4", flexShrink: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    marginTop: 2,
                  }}
                >
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#16a34a" }}>{section.number}</span>
                </div>
                <div style={{ flex: 1 }}>
                  <h2
                    style={{
                      fontSize: 18, fontWeight: 700, color: "#1c1917",
                      marginBottom: 12, fontFamily: "Google Sans Display",
                    }}
                  >
                    {section.title}
                  </h2>
                  {section.content}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Footer note */}
        <div
          style={{
            marginTop: 48, padding: "20px 24px", borderRadius: 12,
            border: "1px solid #e7e5e4", backgroundColor: "#fafaf9",
            display: "flex", gap: 12, alignItems: "flex-start",
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, marginTop: 1 }}>
            <circle cx="12" cy="12" r="10" stroke="#78716c" strokeWidth="2" />
            <path d="M12 8v4M12 16h.01" stroke="#78716c" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <p style={{ fontSize: 13.5, color: "#78716c", lineHeight: 1.65, margin: 0 }}>
            For privacy questions, contact the operator of your deployment. See also our{" "}
            <Link href="/terms" style={{ color: "#2563eb", textDecoration: "none", fontWeight: 500 }}>
              Terms of Use
            </Link>
            .
          </p>
        </div>
      </div>

      <InfoFooter />
    </div>
  );
}
