import { INDEX_MD, markdownResponse } from "@/data/agentDocs";

export function GET() {
  return markdownResponse(INDEX_MD);
}
