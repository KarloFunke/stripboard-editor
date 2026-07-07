import type { Metadata } from "next";
import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "Privacy policy for the Stripboard Editor. What data is collected and how it is used.",
  alternates: { canonical: "https://stripboard-editor.com/privacy" },
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen font-mono bg-[#fafafa] dark:bg-[#121212] bg-[radial-gradient(var(--page-dot)_1px,transparent_1.5px)] [background-size:24px_24px] flex flex-col">
      <SiteHeader breadcrumb="privacy" />

      <div className="max-w-2xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12 flex-1">
        <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-sm dark:shadow-neutral-900/30 px-5 sm:px-8 py-7 sm:py-9">
        <h1 className="font-mono text-2xl font-bold text-[#113768] dark:text-[#5b9bd5] mb-6 tracking-tight">Privacy Policy</h1>

        <div className="prose prose-sm text-neutral-700 dark:text-neutral-300 space-y-5">
          <section>
            <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-2 mt-0">About this project</h2>
            <p>
              Stripboard Editor is a personal, non-commercial hobby project by Karl Funke.
              It is not affiliated with or operated by any company. This project does not
              generate revenue and is provided free of charge.
            </p>
          </section>

          <section>
            <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-2">What data is collected</h2>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <strong>Account data:</strong> If you create an account, your username and a
                hashed version of your password are stored. You can optionally add an email
                address to enable password recovery. It is never required, is used only to send
                you a password reset link when you request one, and can be removed again at any time
                in your account settings.
              </li>
              <li>
                <strong>Project data:</strong> Your stripboard projects (components, nets, board layout)
                are stored on the server so you can access them later.
              </li>
              <li>
                <strong>Feedback:</strong> If you send a message through the feedback box, it is stored so it
                can be acted on and replied to. When you are logged in, your messages are linked to your
                account so you can read replies and continue the conversation on the site. Any contact details
                you add while logged out are optional and used only to follow up with you.
              </li>
              <li>
                <strong>Email delivery:</strong> If you request a password reset, your email address is
                passed to{" "}
                <a href="https://resend.com/legal/privacy-policy" className="text-[#113768] dark:text-[#5b9bd5] hover:underline" target="_blank" rel="noopener noreferrer">Resend</a>,
                an email delivery provider, for the sole purpose of sending that one message. It acts as a
                processor on my behalf and is not used for any other purpose.
              </li>
              <li>
                <strong>Session cookie:</strong> A single session cookie is used to keep you logged in.
                This is strictly necessary for the application to function and requires no consent.
              </li>
              <li>
                <strong>Analytics:</strong> This site uses{" "}
                <a href="https://umami.is" className="text-[#113768] dark:text-[#5b9bd5] hover:underline" target="_blank" rel="noopener noreferrer">Umami</a>,
                a privacy-focused, cookieless analytics tool. It collects anonymous page view statistics
                (no personal data, no tracking across sites, no cookies). The analytics data is
                self-hosted in Germany.
              </li>
              <li>
                <strong>Server logs:</strong> Standard web server logs (IP address, timestamp, requested URL)
                are kept for security and debugging purposes and are automatically deleted after 14 days.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-2">Data storage</h2>
            <p>
              All data is stored on a server located in Germany. The only data shared with a third
              party is your email address, and only when you request a password reset, when it is
              passed to Resend to deliver that message (see above). Apart from that, no data is shared
              with third parties, and there are no ads, tracking pixels, or external analytics services
              beyond the self-hosted Umami instance mentioned above.
            </p>
          </section>

          <section>
            <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-2">Your rights</h2>
            <p>
              Under the GDPR, you have the right to access, correct, or delete your personal data.
              You can delete your account at any time. Deleting your account will also permanently
              delete all your projects. For any
              data-related requests, please contact me at the address below.
            </p>
          </section>

          <section>
            <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-2">Contact</h2>
            <p>
              Karl Funke<br />
              <a href="mailto:karl.funke@indocu.de" className="text-[#113768] dark:text-[#5b9bd5] hover:underline">karl.funke@indocu.de</a>
            </p>
          </section>
        </div>

        <div className="mt-10 pt-4 border-t border-neutral-200 dark:border-neutral-700 text-xs text-neutral-400 dark:text-neutral-500">
          <Link href="/" className="text-neutral-500 dark:text-neutral-400 hover:text-[#113768] dark:hover:text-[#5b9bd5] transition-colors">
            Back to Stripboard Editor
          </Link>
        </div>
        </div>
      </div>

      <SiteFooter />
    </div>
  );
}
