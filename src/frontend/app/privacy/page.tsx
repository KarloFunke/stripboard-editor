import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "Privacy policy for the Stripboard Editor — what data is collected and how it is used.",
  alternates: { canonical: "https://stripboard-editor.com/privacy" },
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-[#fafafa]">
      <div className="h-12 bg-[#113768] text-white flex items-center px-6">
        <a href="/" className="font-semibold tracking-wide hover:opacity-80 transition-opacity">
          Stripboard Editor
        </a>
      </div>

      <div className="max-w-2xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-bold text-[#113768] mb-6">Privacy Policy</h1>

        <div className="prose prose-sm text-neutral-700 space-y-5">
          <section>
            <h2 className="text-lg font-semibold text-neutral-800 mt-0">About this project</h2>
            <p>
              Stripboard Editor is a personal, non-commercial hobby project by Karl Funke.
              It is not affiliated with or operated by any company. This project does not
              generate revenue and is provided free of charge.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-800">What data is collected</h2>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <strong>Account data</strong> — If you create an account, your username and a
                hashed version of your password are stored. No email address is required or collected.
              </li>
              <li>
                <strong>Project data</strong> — Your stripboard projects (components, nets, board layout)
                are stored on the server so you can access them later.
              </li>
              <li>
                <strong>Session cookie</strong> — A single session cookie is used to keep you logged in.
                This is strictly necessary for the application to function and requires no consent.
              </li>
              <li>
                <strong>Analytics</strong> — This site uses{" "}
                <a href="https://umami.is" className="text-[#113768] hover:underline" target="_blank" rel="noopener noreferrer">Umami</a>,
                a privacy-focused, cookieless analytics tool. It collects anonymous page view statistics
                (no personal data, no tracking across sites, no cookies). The analytics data is
                self-hosted in Germany.
              </li>
              <li>
                <strong>Server logs</strong> — Standard web server logs (IP address, timestamp, requested URL)
                are kept for security and debugging purposes and are automatically deleted after 14 days.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-800">Data storage</h2>
            <p>
              All data is stored on a server located in Germany. No data is shared with
              third parties. There are no ads, tracking pixels, or external analytics services
              beyond the self-hosted Umami instance mentioned above.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-800">Your rights</h2>
            <p>
              Under the GDPR, you have the right to access, correct, or delete your personal data.
              You can delete your account at any time. Deleting your account will also permanently
              delete all your projects. For any
              data-related requests, please contact me at the address below.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-800">Contact</h2>
            <p>
              Karl Funke<br />
              <a href="mailto:karl.funke@indocu.de" className="text-[#113768] hover:underline">karl.funke@indocu.de</a>
            </p>
            <p className="text-xs text-neutral-400 mt-2">
              This is a personal hobby project. For business inquiries, visit{" "}
              <a href="https://indocu.de?utm_source=stripboard-editor" className="text-neutral-500 hover:underline">indocu.de</a>.
            </p>
          </section>
        </div>

        <div className="mt-10 pt-4 border-t border-neutral-200 text-xs text-neutral-400">
          <a href="/" className="text-neutral-500 hover:text-[#113768] transition-colors">
            Back to Stripboard Editor
          </a>
        </div>
      </div>
    </div>
  );
}
