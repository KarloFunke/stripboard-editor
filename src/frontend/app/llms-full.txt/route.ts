import { AGENT_DOCS, SITE } from "@/data/agentDocs";

// Every markdown twin concatenated into one document, the companion to
// llms.txt for agents that want the whole site in a single fetch.
const HEADER = `# Stripboard Editor: full documentation

> Every page of ${SITE} concatenated into one document, in reading order:
> the site overview, the quick guide, the full explanation of the automatic
> layouter, the changelog and the privacy policy. The index version, with
> links instead of full text, is at ${SITE}/llms.txt.

`;

const BODY =
  HEADER +
  AGENT_DOCS.map((d) => `---\n\nSource: ${SITE}${d.path}\n\n${d.body}`).join("\n");

export function GET() {
  return new Response(BODY, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      Link: `<${SITE}/llms.txt>; rel="describedby"`,
    },
  });
}
